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
import TurndownService from "turndown";
import {
  EmbeddingFunction,
  LanceSchema,
  register,
} from "@lancedb/lancedb/embedding";
import { type Float, Float32, Utf8 } from "apache-arrow";
import { pipeline } from "@huggingface/transformers";

const { turndown } = new TurndownService();
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

const server = new Server(
  {
    name: "my-apple-notes-mcp",
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
        name: "list-notes",
        description: "Lists just the titles of all my Apple Notes",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "index-notes",
        description:
          "Index all my Apple Notes for Semantic Search. Please tell the user that the sync takes couple of seconds up to couple of minutes depending on how many notes you have.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "get-note",
        description: "Get a note full content and details by title",
        inputSchema: {
          type: "object",
          properties: {
            title: z.string(),
          },
          required: ["title"],
        },
      },
      {
        name: "search-notes",
        description: "Search for notes by title or content",
        inputSchema: {
          type: "object",
          properties: {
            query: z.string(),
          },
          required: ["query"],
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
  let report = "";
  const allNotes = (await getNotes()) || [];
  const notesDetails = await Promise.all(
    allNotes.map((note) => {
      try {
        return getNoteDetailsByTitle(note);
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
          content: turndown(node.content || ""), // this sometimes fails
        };
      } catch (error) {
        return node;
      }
    })
    .map((note, index) => ({
      id: index.toString(),
      title: note.title,
      content: note.content, // turndown(note.content || ""),
      creation_date: note.creation_date,
      modification_date: note.modification_date,
    }));

  await notesTable.add(chunks);

  return { chunks: chunks.length, report, allNotes: allNotes.length };
};

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request, c) => {
  const notesTable = await db.createEmptyTable("notes", notesTableSchema, {
    mode: "create",
    existOk: true,
  });
  await notesTable.createIndex("content", {
    config: lancedb.Index.fts(),
  });
  const { name, arguments: args } = request.params;

  try {
    if (name === "list-notes") {
      return createTextResponse(
        `There are ${await notesTable.countRows()} notes in your Apple Notes database.`
      );
    } else if (name == "get-note") {
      try {
        const { title } = GetNoteSchema.parse(args);
        const note = await getNoteDetailsByTitle(title);

        return createTextResponse(`${note}`);
      } catch (error) {
        return createTextResponse(error.message);
      }
    } else if (name === "index-notes") {
      const count = await indexNotes(notesTable);
      return createTextResponse(
        `Indexed ${count} notes! You can now search for them using the "search-notes" tool.`
      );
    } else if (name === "search-notes") {
      const { query } = QueryNotesSchema.parse(args);

      const [vectorResults, ftsSearchResults] = await Promise.all([
        notesTable.search(query, "vector").limit(20).toArray(),
        notesTable.search(query, "fts").limit(20).toArray(),
      ]);

      const k = 60; // constant for RRF calculation
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

      const combinedResults = Array.from(scores.entries())
        .sort(([, a], [, b]) => b - a)
        .slice(0, 20)
        .map(([key]) => {
          const [title, content] = key.split("::");
          return { title, content };
        });

      return createTextResponse(JSON.stringify(combinedResults));
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
console.error("Local Machine MCP Server running on stdio");

const createTextResponse = (text: string) => ({
  content: [{ type: "text", text }],
});
