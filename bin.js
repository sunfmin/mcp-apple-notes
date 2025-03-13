#!/usr/bin/env bun
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Get the directory of the current module
const __dirname = dirname(fileURLToPath(import.meta.url));

// Import and run the main file
import('./index.ts').catch(err => {
  console.error('Failed to start MCP server:', err);
  process.exit(1);
}); 