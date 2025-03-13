// Usage: bun test --timeout 120000
/// <reference types="bun-types" />
import { test, describe, expect, beforeAll, afterAll } from "bun:test";
import { runJxa } from "run-jxa";

describe("Apple Notes Integration", () => {
  const MCP_FOLDER_NAME = "MCP Notes";

  // Helper function to create or get MCP folder
  const getOrCreateMCPFolder = async () => {
    return await runJxa(`
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
  };

  // Helper function to create a test note (in root folder)
  const createTestNote = async (title: string, content: string) => {
    await runJxa(`
      const app = Application('Notes');
      
      const note = app.make({new: 'note', withProperties: {
        name: "${title.replace(/[\\'"]/g, "\\$&")}",
        body: "${content.replace(/[\\'"]/g, "\\$&")}"
      }});
    `);
  };

  // Helper function to create a test note in MCP folder
  const createTestNoteInMCPFolder = async (title: string, content: string) => {
    await getOrCreateMCPFolder();
    
    await runJxa(`
      const app = Application('Notes');
      
      // Find the MCP folder
      const folders = Array.from(app.folders());
      const mcpFolder = folders.find(folder => folder.name() === "${MCP_FOLDER_NAME}");
      
      if (!mcpFolder) {
        throw new Error("MCP folder not found");
      }
      
      // Create note in the MCP folder
      const note = app.make({new: 'note', at: mcpFolder, withProperties: {
        name: "${title.replace(/[\\'"]/g, "\\$&")}",
        body: "${content.replace(/[\\'"]/g, "\\$&")}"
      }});
    `);
  };

  // Helper function to delete a test note
  const deleteTestNote = async (title: string) => {
    await runJxa(`
      const app = Application('Notes');
      
      // Find and delete the note across all folders
      const note = app.notes.whose({name: "${title.replace(/[\\'"]/g, "\\$&")}"})[0];
      if (note) {
        note.delete();
      }
    `);
  };

  // Clean up test notes before and after tests
  beforeAll(async () => {
    await deleteTestNote("Test Note");
    await deleteTestNote("Another Test Note");
    await deleteTestNote("MCP Test Note");
  });

  afterAll(async () => {
    await deleteTestNote("Test Note");
    await deleteTestNote("Another Test Note");
    await deleteTestNote("MCP Test Note");
  });

  test("should list notes from all folders", async () => {
    // Create test notes in different locations
    await createTestNote("Test Note", "This is a test note content");
    await createTestNoteInMCPFolder("MCP Test Note", "This is a test note in MCP folder");

    // Get all notes
    const notes = await runJxa(`
      const app = Application('Notes');
      const notes = Array.from(app.notes());
      const titles = notes.map(note => note.properties().name);
      return titles;
    `) as string[];

    // Verify both test notes exist
    expect(Array.isArray(notes)).toBe(true);
    expect(notes.includes("Test Note")).toBe(true);
    expect(notes.includes("MCP Test Note")).toBe(true);
  });

  test("should get note details from any folder", async () => {
    const testContent = "This is a test note content";
    await createTestNote("Test Note", testContent);

    const note = await runJxa(`
      const app = Application('Notes');
      const note = app.notes.whose({name: "Test Note"})[0];
      
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
    `);

    const noteDetails = JSON.parse(note as string);
    expect(noteDetails.title).toBe("Test Note");
    expect(noteDetails.content).toContain(testContent);
    expect(noteDetails.creation_date).toBeDefined();
    expect(noteDetails.modification_date).toBeDefined();
  });

  test("should search notes across all folders", async () => {
    // Create test notes in different locations
    await createTestNote("Test Note", "This is a test note content");
    await createTestNoteInMCPFolder("MCP Test Note", "This note has unique content");

    // Search for notes
    const results = await runJxa(`
      const app = Application('Notes');
      const query = "unique content";
      
      // Search across all folders
      const notes = Array.from(app.notes()).filter(note => {
        const content = note.body().toLowerCase();
        const title = note.name().toLowerCase();
        const searchQuery = query.toLowerCase();
        return content.includes(searchQuery) || title.includes(searchQuery);
      }).map(note => ({
        title: note.name(),
        content: note.body(),
        creation_date: note.creationDate().toLocaleString(),
        modification_date: note.modificationDate().toLocaleString()
      }));
      
      return JSON.stringify(notes);
    `);

    const searchResults = JSON.parse(results as string);
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0].title).toBe("MCP Test Note");
    expect(searchResults[0].content).toContain("unique content");
  });

  test("should create new note in MCP folder", async () => {
    const title = "MCP Test Note";
    const content = "This is a test note in MCP folder";

    await runJxa(`
      const app = Application('Notes');
      
      // Find the MCP folder
      const folders = Array.from(app.folders());
      const mcpFolder = folders.find(folder => folder.name() === "${MCP_FOLDER_NAME}");
      
      if (!mcpFolder) {
        throw new Error("MCP folder not found");
      }
      
      // Create note in the MCP folder
      const note = app.make({new: 'note', at: mcpFolder, withProperties: {
        name: "${title}",
        body: "${content}"
      }});
    `);

    // Verify the note was created in MCP folder
    const noteInMCPFolder = await runJxa(`
      const app = Application('Notes');
      
      // Find the MCP folder
      const folders = Array.from(app.folders());
      const mcpFolder = folders.find(folder => folder.name() === "${MCP_FOLDER_NAME}");
      
      if (!mcpFolder) {
        return false;
      }
      
      // Check if note exists in MCP folder
      const notes = Array.from(mcpFolder.notes());
      return notes.some(note => note.name() === "${title}");
    `);

    expect(noteInMCPFolder).toBe(true);
  });

  test("MCP folder should exist", async () => {
    await getOrCreateMCPFolder();
    
    const folderExists = await runJxa(`
      const app = Application('Notes');
      const folders = Array.from(app.folders());
      return folders.some(folder => folder.name() === "${MCP_FOLDER_NAME}");
    `);
    
    expect(folderExists).toBe(true);
  });
});
