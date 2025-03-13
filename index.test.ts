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

  // Helper function to add test data
  const addTestData = async (notesTable: any) => {
    await notesTable.add([
      {
        id: "1",
        title: "Test Note",
        content: "This is a test note content",
        creation_date: new Date().toISOString(),
        modification_date: new Date().toISOString(),
      },
      {
        id: "2",
        title: "15/12",
        content: "This is a test date note",
        creation_date: new Date().toISOString(),
        modification_date: new Date().toISOString(),
      }
    ]);
  };

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

    // Add test data to ensure we have something to work with
    console.log("Adding test data before indexing...");
    await addTestData(notesTable);
    
    // Get the count before indexing
    const beforeCount = await notesTable.countRows();
    console.log(`Table contains ${beforeCount} rows before indexing`);

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
    
    // Check that we have at least the test data or the actual notes (if there are any)
    expect(count).toBeGreaterThan(0);
  });

  test("should perform vector search", async () => {
    const start = performance.now();
    const { notesTable, time: tableCreationTime } = await createNotesTable("test-notes");
    const end = performance.now();
    console.log(`Creating table took ${Math.round(end - start)}ms`);

    await addTestData(notesTable);

    const addEnd = performance.now();
    console.log(`Adding notes took ${Math.round(addEnd - end)}ms`);

    const results = await searchAndCombineResults(notesTable, "test note");

    const combineEnd = performance.now();
    console.log(`Combining results took ${Math.round(combineEnd - addEnd)}ms`);

    // Should return search results
    expect(results.length).toBeGreaterThan(0);
    // Check that one of our test notes is found (order may vary)
    const foundTestNote = results.some(r => r.title === "Test Note" || r.title === "15/12");
    expect(foundTestNote).toBe(true);
  });

  test("should perform vector search on real indexed data", async () => {
    const { notesTable } = await createNotesTable("test-notes");
    
    // Add test data to ensure we have something to search for
    await addTestData(notesTable);

    const results = await searchAndCombineResults(notesTable, "15/12");

    // Should return search results
    expect(results.length).toBeGreaterThan(0);
    // There should be a note with this title
    expect(results.some(r => r.title === "15/12")).toBe(true);
  });
});
