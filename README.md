# MCP Apple Notes

![MCP Apple Notes](./images/logo.png)

A [Model Context Protocol (MCP)](https://www.anthropic.com/news/model-context-protocol) server that enables semantic search and RAG (Retrieval Augmented Generation) over your Apple Notes. This allows AI assistants like Claude to search and reference your Apple Notes during conversations.

![MCP Apple Notes](./images/demo.png)

## Features

- 🔍 Semantic search over Apple Notes using [`all-MiniLM-L6-v2`](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) on-device embeddings model
- 📝 Full-text search capabilities
- 📊 Vector storage using [LanceDB](https://lancedb.github.io/lancedb/)
- 🤖 MCP-compatible server for AI assistant integration
- 🍎 Native Apple Notes integration via JXA
- 🏃‍♂️ Fully local execution - no API keys needed

## Prerequisites

- [Bun](https://bun.sh/docs/installation)
- [Claude Desktop](https://claude.ai/download) or [Cursor](https://cursor.sh/)

## Installation

### Option 1: Direct from GitHub (Recommended)

You can install and run the MCP server directly using Bun's package execution feature:

```bash
bunx git+https://github.com/sunfmin/mcp-apple-notes
```

### Option 2: Manual Installation

1. Clone the repository:

```bash
git clone https://github.com/sunfmin/mcp-apple-notes
cd mcp-apple-notes
```

2. Install dependencies:

```bash
bun install
```

3. Run the server:

```bash
bun start
```

## Usage with Claude Desktop

1. Open Claude desktop app and go to Settings -> Developer -> Edit Config

![Claude Desktop Settings](./images/desktop_settings.png)

2. Open the `claude_desktop_config.json` and add the following entry:

```json
{
  "mcpServers": {
    "local-machine": {
      "command": "/Users/<YOUR_USER_NAME>/.bun/bin/bun",
      "args": ["x", "git+https://github.com/sunfmin/mcp-apple-notes"]
    }
  }
}
```

Important: Replace `<YOUR_USER_NAME>` with your actual username.

## Usage with Cursor

1. Open Cursor and go to Settings -> Claude AI MCP
2. Add the following command:

```
bunx git+https://github.com/sunfmin/mcp-apple-notes
```

## Getting Started

1. Restart Claude desktop app or Cursor. You should see a connection status indicator.
2. Start by indexing your notes. Ask Claude to index your notes by saying something like: "Index my notes" or "Index my Apple Notes".

## Troubleshooting

To see logs:

```bash
tail -n 50 -f ~/Library/Logs/Claude/mcp-server-local-machine.log
# or
tail -n 50 -f ~/Library/Logs/Claude/mcp.log
```

## Todos

- [ ] Apple notes are returned in the HTML format. We should turn them to Markdown and embed that
- [ ] Chunk source content using recursive text splitter or markdown text splitter
- [ ] Add an option to use custom embeddings model
- [ ] More control over DB - purge, custom queries, etc.
- [x] Storing notes in Notes via Claude
