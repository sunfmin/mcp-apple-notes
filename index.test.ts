// Usage: bun test --timeout 120000
/// <reference types="bun-types" />
import { test, describe, expect } from "bun:test";
import * as lancedb from "@lancedb/lancedb";
import path from "node:path";
import os from "node:os";
import { LanceSchema } from "@lancedb/lancedb/embedding";
import { Utf8 } from "apache-arrow";
import {
  createNotesTable,
  indexNotes,
  OnDeviceEmbeddingFunction,
  searchAndCombineResults,
} from "./index";

describe("Apple Notes Indexing", async () => {
  const db = await lancedb.connect(
    path.join(os.homedir(), ".mcp-apple-notes", "data")
  );
  const func = new OnDeviceEmbeddingFunction();

  const notesSchema = LanceSchema({
    title: func.sourceField(new Utf8()),
    content: func.sourceField(new Utf8()),
    creation_date: func.sourceField(new Utf8()),
    modification_date: func.sourceField(new Utf8()),
    vector: func.vectorField(),
  });

  test("should create notes table", async () => {
    const notesTable = await db.createEmptyTable("test-notes", notesSchema, {
      mode: "create",
      existOk: true,
    });

    // Notes table should be created
    expect(notesTable).toBeDefined();
    const count = await notesTable.countRows();
    // Should be able to count rows
    expect(typeof count).toBe("number");
  });

  // Note: This test requires a very long timeout due to indexing operations
  // Run with: bun test --timeout 120000 (2 minutes)
  test("should index all notes correctly", async () => {
    console.log("Starting notes indexing test...");
    
    const startTableCreation = performance.now();
    const { notesTable, time: tableCreationTime } = await createNotesTable("test-notes");
    console.log(`Table creation took ${Math.round(tableCreationTime)}ms`);

    console.log("Beginning notes indexing process...");
    const startIndexing = performance.now();
    const indexResult = await indexNotes(notesTable);
    const endIndexing = performance.now();
    
    console.log(`Indexing completed in ${Math.round(endIndexing - startIndexing)}ms`);
    console.log(`Found ${indexResult.allNotes} notes, indexed ${indexResult.chunks} chunks`);
    
    if (indexResult.report) {
      console.log("Indexing report:", indexResult.report);
    }

    const count = await notesTable.countRows();
    console.log(`Table contains ${count} rows after indexing`);
    
    // Should be able to count rows
    expect(typeof count).toBe("number");
    // Should have rows after indexing
    expect(count).toBeGreaterThan(0);
  });

  test("should perform vector search", async () => {
    const start = performance.now();
    const { notesTable } = await createNotesTable("test-notes");
    const end = performance.now();
    console.log(`Creating table took ${Math.round(end - start)}ms`);

    await notesTable.add([
      {
        id: "1",
        title: "Test Note",
        content: "This is a test note content",
        creation_date: new Date().toISOString(),
        modification_date: new Date().toISOString(),
      },
    ]);

    const addEnd = performance.now();
    console.log(`Adding notes took ${Math.round(addEnd - end)}ms`);

    const results = await searchAndCombineResults(notesTable, "test note");

    const combineEnd = performance.now();
    console.log(`Combining results took ${Math.round(combineEnd - addEnd)}ms`);

    // Should return search results
    expect(results.length).toBeGreaterThan(0);
    // Should find the test note
    expect(results[0].title).toBe("Test Note");
  });

  test("should perform vector search on real indexed data", async () => {
    const { notesTable } = await createNotesTable("test-notes");

    const results = await searchAndCombineResults(notesTable, "15/12");

    // Should return search results
    expect(results.length).toBeGreaterThan(0);
    // Should find the test note
    expect(results[0].title).toBe("Test Note");
  });
});
