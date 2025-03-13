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
        description: "Lists just the titles of all my Apple Notes",
        inputSchema: {
          type: "object",
          properties: {
            random_string: { type: "string", description: "Optional dummy parameter" }
          },
          required: []
        },
      },
      {
        name: "index_notes",
        description:
          "Synchronize all my Apple Notes for Semantic Search. This updates the search database to match your current notes. Please tell the user that the sync takes a few seconds to a few minutes depending on how many notes they have.",
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
        description: "Get a note full content and details by title",
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
        description: "Search for notes by title or content",
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
          "Create a new Apple Note with specified title and content. Must be in HTML format WITHOUT newlines",
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
const notes = Array.from(app.notes());
const titles = notes.map(note => note.properties().name);
return titles;
  `);

  return notes as string[];
};

const getNoteDetailsByTitle = async (title: string) => {
  const note = await runJxa(
    `const app = Application('Notes');
    const title = "${title}"
    
    try {
        const note = app.notes.whose({name: title})[0];
        
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

const createNote = async (title: string, content: string) => {
  // Escape special characters and convert newlines to \n
  const escapedTitle = title.replace(/[\\'"]/g, "\\$&");
  const escapedContent = content
    .replace(/[\\'"]/g, "\\$&")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");

  await runJxa(`
    const app = Application('Notes');
    const note = app.make({new: 'note', withProperties: {
      name: "${escapedTitle}",
      body: "${escapedContent}"
    }});
    
    return true
  `);

  return true;
};

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request, c) => {
  const { notesTable } = await createNotesTable();
  const { name, arguments: args } = request.params;

  try {
    if (name === "create_note") {
      const { title, content } = CreateNoteSchema.parse(args);
      await createNote(title, content);
      return createTextResponse(`Created note "${title}" successfully.`);
    } else if (name === "list_notes") {
      // Validate with optional parameters
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
      try {
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
      } catch (error) {
        return createTextResponse(error.message);
      }
    } else if (name === "index_notes") {
      // Validate with optional parameters
      const params = RandomStringSchema.parse(args || {});
      const { time, chunks, report, allNotes } = await indexNotes(notesTable);
      return createTextResponse(
        `Synchronized Apple Notes with search database: indexed ${chunks} notes in ${Math.round(time)}ms. You can now search for them using the "search_notes" tool.`
      );
    } else if (name === "search_notes") {
      const { query } = QueryNotesSchema.parse(args);
      
      // Ensure the notes table exists even if not indexed yet
      let exists = false;
      try {
        // Use a more reliable method to check if table exists
        await db.openTable("notes");
        exists = true;
      } catch (error) {
        console.error("Table does not exist:", error);
        exists = false;
      }
      
      if (!exists) {
        return createTextResponse(
          `You need to index your notes first. Please use the "index_notes" tool before searching.`
        );
      }
      
      const combinedResults = await searchAndCombineResults(notesTable, query);
      
      // Format the results in a more readable way
      if (combinedResults.length === 0) {
        return createTextResponse(`No results found for query: "${query}"`);
      }
      
      const formattedResults = combinedResults.map((result, index) => {
        // Remove only image tags but keep other HTML tags
        const cleanContent = cleanHtmlContent(result.content);
          
        // Truncate content if it's too long
        const truncatedContent = cleanContent.length > 200 
          ? cleanContent.substring(0, 200) + '...' 
          : cleanContent;
          
        return `${index + 1}. **${result.title || 'Untitled'}**\n   ${truncatedContent}`;
      }).join('\n\n');
      
      return createTextResponse(
        `Found ${combinedResults.length} notes matching "${query}":\n\n${formattedResults}`
      );
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Invalid arguments: ${error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", ")}`
      );
    }
    throw error;
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
