import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as lancedb from "@lancedb/lancedb";
import { runJxa } from "run-jxa";
import path from "node:path";
import os from "node:os";
import { NodeHtmlMarkdown } from "node-html-markdown";
import {
  EmbeddingFunction,
  LanceSchema,
  register,
} from "@lancedb/lancedb/embedding";
import { type Float, Float32, Utf8 } from "apache-arrow";
import { pipeline } from "@huggingface/transformers";

const nhm = new NodeHtmlMarkdown();
const db = await lancedb.connect(
  path.join(os.homedir(), ".mcp-apple-notes", "data")
);
const extractor = await pipeline(
  "feature-extraction",
  "Xenova/all-MiniLM-L6-v2"
);

@register("openai")
export class OnDeviceEmbeddingFunction extends EmbeddingFunction<string> {
  toJSON(): object {
    return {};
  }
  ndims() {
    return 384;
  }
  embeddingDataType(): Float {
    return new Float32();
  }
  async computeQueryEmbeddings(data: string) {
    const output = await extractor(data, { pooling: "mean" });
    return output.data as number[];
  }
  async computeSourceEmbeddings(data: string[]) {
    return await Promise.all(
      data.map(async (item) => {
        const output = await extractor(item, { pooling: "mean" });

        return output.data as number[];
      })
    );
  }
}

const func = new OnDeviceEmbeddingFunction();

const notesTableSchema = LanceSchema({
  title: func.sourceField(new Utf8()),
  content: func.sourceField(new Utf8()),
  creation_date: func.sourceField(new Utf8()),
  modification_date: func.sourceField(new Utf8()),
  vector: func.vectorField(),
});

const QueryNotesSchema = z.object({
  query: z.string(),
});

const GetNoteSchema = z.object({
  title: z.string(),
});

const CreateNoteSchema = z.object({
  title: z.string(),
  content: z.string(),
});

const RandomStringSchema = z.object({
  random_string: z.string().optional().default("dummy"),
});

const server = new Server(
  {
    name: "apple-notes",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_notes",
        description: "Lists just the titles of all my Apple Notes from all folders",
        inputSchema: {
          type: "object",
          properties: {
            random_string: { type: "string", description: "Optional dummy parameter" }
          },
          required: []
        },
      },
      {
        name: "get_note",
        description: "Get a note full content and details by title from any folder",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" }
          },
          required: ["title"],
        },
      },
      {
        name: "search_notes",
        description: "Search for notes using Apple's native search functionality. This leverages the Apple Notes app's built-in search for faster and more accurate results.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" }
          },
          required: ["query"],
        },
      },
      {
        name: "create_note",
        description:
          "Create a new Apple Note with specified title and content. The note will be created in the 'MCP Notes' folder. Must be in HTML format WITHOUT newlines",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: { type: "string" },
          },
          required: ["title", "content"],
        },
      },
    ],
  };
});

const getNotes = async () => {
  const notes = await runJxa(`
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    
    // Get all notes across all folders
    const notes = Array.from(app.notes());
    const titles = notes.map(note => note.properties().name);
    return titles;
  `);

  return notes as string[];
};

const getNoteDetailsByTitle = async (title: string) => {
  const note = await runJxa(
    `const app = Application('Notes');
    const title = "${title.replace(/[\\'"]/g, "\\$&")}"
    
    try {
        // Search for note across all folders
        const note = app.notes.whose({name: title})[0];
        
        if (!note) {
            return "{}";
        }
        
        const noteInfo = {
            title: note.name(),
            content: note.body(),
            creation_date: note.creationDate().toLocaleString(),
            modification_date: note.modificationDate().toLocaleString()
        };
        
        return JSON.stringify(noteInfo);
    } catch (error) {
        return "{}";
    }`
  );

  return JSON.parse(note as string) as {
    title: string;
    content: string;
    creation_date: string;
    modification_date: string;
  };
};

export const indexNotes = async (notesTable: any) => {
  const start = performance.now();
  let report = "";
  try {
    // Clear existing records to prevent duplicates
    console.log("Clearing existing notes from table...");
    const clearStart = performance.now();
    try {
      // Delete all records from the table
      await notesTable.delete("true");
      const clearEnd = performance.now();
      console.log(`Cleared existing records in ${Math.round(clearEnd - clearStart)}ms`);
    } catch (error) {
      report += `Warning: Failed to clear existing records: ${error.message}. Will proceed with indexing.\n`;
      console.warn("Failed to clear existing records:", error);
    }

    const allNotes = (await getNotes()) || [];
    const notesDetails = await Promise.all(
      allNotes.map(async (note) => {
        try {
          return await getNoteDetailsByTitle(note);
        } catch (error) {
          report += `Error getting note details for ${note}: ${error.message}\n`;
          return {} as any;
        }
      })
    );

    const chunks = notesDetails
      .filter((n) => n.title)
      .map((node) => {
        try {
          return {
            ...node,
            content: nhm.translate(node.content || ""),
          };
        } catch (error) {
          report += `Error converting content for ${node.title}: ${error.message}\n`;
          return node;
        }
      })
      .map((note, index) => ({
        id: index.toString(),
        title: note.title,
        content: note.content,
        creation_date: note.creation_date,
        modification_date: note.modification_date,
      }));

    if (chunks.length === 0) {
      return {
        chunks: 0,
        report: report + "No valid notes found to index.",
        allNotes: allNotes.length,
        time: performance.now() - start,
      };
    }

    await notesTable.add(chunks);

    return {
      chunks: chunks.length,
      report,
      allNotes: allNotes.length,
      time: performance.now() - start,
    };
  } catch (error) {
    report += `Error during indexing: ${error.message}\n`;
    return {
      chunks: 0,
      report,
      allNotes: 0,
      time: performance.now() - start,
      error: error.message,
    };
  }
};

export const createNotesTable = async (overrideName?: string) => {
  const start = performance.now();
  const notesTable = await db.createEmptyTable(
    overrideName || "notes",
    notesTableSchema,
    {
      mode: "create",
      existOk: true,
    }
  );

  const indices = await notesTable.listIndices();
  if (!indices.find((index) => index.name === "content_idx")) {
    await notesTable.createIndex("content", {
      config: lancedb.Index.fts(),
      replace: true,
    });
  }
  return { notesTable, time: performance.now() - start };
};

// Constants for folder name
const MCP_FOLDER_NAME = "MCP Notes";

/**
 * Creates or gets the MCP folder
 * @returns Promise that resolves to true if successful
 */
const getOrCreateMCPFolder = async (): Promise<boolean> => {
  try {
    const result = await runJxa(`
      const app = Application('Notes');
      
      // Check if the folder already exists
      const folders = Array.from(app.folders());
      let mcpFolder = folders.find(folder => folder.name() === "${MCP_FOLDER_NAME}");
      
      // If not, create it
      if (!mcpFolder) {
        mcpFolder = app.make({new: 'folder', withProperties: {name: "${MCP_FOLDER_NAME}"}});
      }
      
      return true;
    `);
    
    return result as boolean;
  } catch (error) {
    console.error("Error creating MCP folder:", error);
    return false;
  }
};

const createNote = async (title: string, content: string) => {
  // Ensure the MCP folder exists
  await getOrCreateMCPFolder();
  
  // Escape special characters and convert newlines to \n
  const escapedTitle = title.replace(/[\\'"]/g, "\\$&");
  const escapedContent = content
    .replace(/[\\'"]/g, "\\$&")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");

  await runJxa(`
    const app = Application('Notes');
    
    // Find the MCP folder
    const folders = Array.from(app.folders());
    const mcpFolder = folders.find(folder => folder.name() === "${MCP_FOLDER_NAME}");
    
    if (!mcpFolder) {
      throw new Error("MCP folder not found. Please try again.");
    }
    
    // Create the note in the MCP folder
    const note = app.make({new: 'note', at: mcpFolder, withProperties: {
      name: "${escapedTitle}",
      body: "${escapedContent}"
    }});
    
    return true;
  `);

  return true;
};

const searchNotes = async (query: string) => {
  const results = await runJxa(`
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    
    // Use System Events for UI automation
    const systemEvents = Application('System Events');
    const notesProcess = systemEvents.processes.whose({name: 'Notes'})[0];
    
    // Activate Notes app
    app.activate();
    
    // Escape the query for safe insertion into script
    const searchQuery = "${query.replace(/[\\'"]/g, "\\$&")}";
    
    try {
      // Clear any existing search first (to ensure clean state)
      // Press Command+F to focus search field
      systemEvents.keyCode(3, {using: ['command down']});
      delay(0.2);
      
      // Clear the search field with Escape key
      systemEvents.keyCode(53);
      delay(0.2);
      
      // Press Command+F again
      systemEvents.keyCode(3, {using: ['command down']});
      delay(0.3);
      
      // Type the search query
      systemEvents.keystroke(searchQuery);
      delay(1); // Give more time for search to complete
      
      // Get visible notes after search
      const searchResults = [];
      
      // Get all notes - Apple will only show the matching ones in UI
      // But we can get all notes and check which ones match the query
      const allNotes = app.notes();
      
      for (let i = 0; i < allNotes.length; i++) {
        try {
          const note = allNotes[i];
          const title = note.name();
          const content = note.body();
          
          // Check if this note matches search query
          // The lowercase check ensures we get consistent results
          if (title.toLowerCase().includes(searchQuery.toLowerCase()) || 
              content.toLowerCase().includes(searchQuery.toLowerCase())) {
            searchResults.push({
              title: title,
              content: content,
              creation_date: note.creationDate().toLocaleString(),
              modification_date: note.modificationDate().toLocaleString()
            });
          }
        } catch (e) {
          // Skip notes that can't be accessed
        }
      }
      
      // Clear search field with Escape key to exit search mode
      systemEvents.keyCode(53);
      
      return JSON.stringify(searchResults);
    } catch (error) {
      // If there's an error with UI automation, return empty results
      console.log('UI search failed: ' + error);
      return JSON.stringify([]);
    }
  `);

  return JSON.parse(results as string) as {
    title: string;
    content: string;
    creation_date: string;
    modification_date: string;
  }[];
};

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request, c) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "create_note") {
      const { title, content } = CreateNoteSchema.parse(args);
      await createNote(title, content);
      return createTextResponse(`Created note "${title}" successfully.`);
    } else if (name === "list_notes") {
      const params = RandomStringSchema.parse(args || {});
      const titles = await getNotes();
      
      if (!titles || titles.length === 0) {
        return createTextResponse("You don't have any notes in your Apple Notes database.");
      }
      
      const formattedTitles = titles.map((title, index) => `${index + 1}. ${title}`).join('\n');
      return createTextResponse(
        `You have ${titles.length} notes in your Apple Notes database:\n\n${formattedTitles}`
      );
    } else if (name === "get_note") {
      const { title } = GetNoteSchema.parse(args);
      const note = await getNoteDetailsByTitle(title);
      
      if (!note.title) {
        return createTextResponse(`Note with title "${title}" not found.`);
      }
      
      // Remove only image tags from HTML content but keep other HTML tags
      let cleanContent = cleanHtmlContent(note.content);
      
      const formattedNote = [
        `# ${note.title}`,
        `Created: ${note.creation_date || 'Unknown'}`,
        `Modified: ${note.modification_date || 'Unknown'}`,
        '',
        cleanContent
      ].join('\n');
      
      return createTextResponse(formattedNote);
    } else if (name === "search_notes") {
      const { query } = QueryNotesSchema.parse(args);
      const results = await searchNotes(query);
      
      if (results.length === 0) {
        return createTextResponse(`No results found for query: "${query}"`);
      }
      
      const formattedResults = results.map((result, index) => {
        const cleanContent = cleanHtmlContent(result.content);
        const truncatedContent = cleanContent.length > 200 
          ? cleanContent.substring(0, 200) + '...' 
          : cleanContent;
          
        return `${index + 1}. **${result.title || 'Untitled'}**\n   ${truncatedContent}`;
      }).join('\n\n');
      
      return createTextResponse(
        `Found ${results.length} notes matching "${query}":\n\n${formattedResults}`
      );
    }
    
    return createTextResponse("Unknown tool");
  } catch (error) {
    return createTextResponse(`Error: ${error.message}`);
  }
});

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Apple Notes MCP Server running on stdio");

const createTextResponse = (text: string) => ({
  content: [{ type: "text", text }],
});

/**
 * Cleans HTML content by removing image tags but keeping other HTML formatting
 * @param content HTML content to clean
 * @returns Cleaned HTML content with images removed
 */
const cleanHtmlContent = (content: string | null | undefined): string => {
  if (!content) return 'No content';
  
  return content
    .replace(/<img[^>]*>/g, '')  // Remove only image tags
    .replace(/&nbsp;/g, ' ')     // Replace &nbsp; with spaces
    .trim();
};

/**
 * Search for notes by title or content using both vector and FTS search.
 * The results are combined using RRF
 */
export const searchAndCombineResults = async (
  notesTable: lancedb.Table,
  query: string,
  limit = 20
) => {
  try {
    const [vectorResults, ftsSearchResults] = await Promise.all([
      (async () => {
        try {
          const results = await notesTable
            .search(query, "vector")
            .limit(limit)
            .toArray();
          return results;
        } catch (error) {
          console.error("Vector search error:", error);
          return [];
        }
      })(),
      (async () => {
        try {
          const results = await notesTable
            .search(query, "fts", "content")
            .limit(limit)
            .toArray();
          return results;
        } catch (error) {
          console.error("FTS search error:", error);
          return [];
        }
      })(),
    ]);

    const k = 60;
    const scores = new Map<string, number>();

    const processResults = (results: any[], startRank: number) => {
      results.forEach((result, idx) => {
        const key = `${result.title}::${result.content}`;
        const score = 1 / (k + startRank + idx);
        scores.set(key, (scores.get(key) || 0) + score);
      });
    };

    processResults(vectorResults, 0);
    processResults(ftsSearchResults, 0);

    const results = Array.from(scores.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([key]) => {
        const [title, content] = key.split("::");
        return { title, content };
      });

    return results;
  } catch (error) {
    console.error("Search error:", error);
    return [];
  }
};
