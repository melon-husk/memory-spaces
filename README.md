# memory-spaces

[![npm](https://img.shields.io/npm/v/memory-spaces.svg)](https://www.npmjs.com/package/memory-spaces)

A unified, **space-separated memory** MCP server for desktop LLM apps (Cursor,
Cline, Claude Desktop, Codex — anything that speaks [MCP](https://modelcontextprotocol.io)).

> **Install:** published on npm as [`memory-spaces`](https://www.npmjs.com/package/memory-spaces).
> No install step needed — point your MCP client at `npx -y memory-spaces`
> (see [Connecting a client](#connecting-a-client)).

Content is partitioned into **spaces** (e.g. `personal`, `work`). One space is
active at a time; every content tool only ever touches the active space, so work
notes never leak into a personal chat and vice versa.

Each space holds two kinds of content:

- **Memories** — short, curated facts you explicitly ask to remember.
- **Knowledge base** — longer documents you ingest, chunked into passages for
  reference retrieval.

## Tools

| Tool | Scope | Description |
|------|-------|-------------|
| `list_spaces` | global | List spaces, mark the active one |
| `current_space` | global | Report the active space |
| `switch_space` | global | Set/create the active space |
| `remember` | active space | Store a memory (explicit writes only) |
| `recall` | active space | Keyword search over memories; recent if no query |
| `forget` | active space | Delete a memory by id |
| `add_document` † | active space | Ingest + chunk a document into the knowledge base |
| `search_knowledge` † | active space | Keyword search over knowledge-base passages |
| `list_documents` † | active space | List knowledge-base documents |
| `remove_document` † | active space | Delete a document and its passages |

† Knowledge-base tools, gated behind a feature flag — see below.

## Feature flag: knowledge base

The knowledge base is **off by default**. When disabled, its four tools are not
registered at all, so they never appear to the client. Enable it either way:

- Env var: `MEMORY_SPACES_ENABLE_KB=1` (also accepts `true` / `yes` / `on`)
- CLI flag: pass `--enable-kb`

In a client config:

```json
{
  "mcpServers": {
    "memory-spaces": {
      "command": "node",
      "args": ["/absolute/path/to/memory-spaces/dist/index.js", "--enable-kb"]
    }
  }
}
```

The server logs which mode it booted in to stderr on startup.

## Storage

Local-first, no database, no native dependencies. One directory per space:

```
~/.memory-spaces/
  state.json              { "activeSpace": "work" }
  spaces/
    work/
      memories.json       atomic facts
      documents.json      knowledge-base doc metadata
      chunks.json         passages (+ reserved `vector` field for later)
    personal/
      ...
```

Knowledge-base retrieval is keyword-based today. Each chunk carries an unused
`vector` field so semantic search can be added behind the same `MemoryStore`
interface without a data migration.

Writes are atomic (temp file + rename). All storage sits behind the
`MemoryStore` interface in [`src/store.ts`](src/store.ts), so swapping the JSON
backend for SQLite or a vector store later is a single-file change.

## Connecting a client

Register the server in your MCP client config (e.g. Claude Desktop's
`claude_desktop_config.json`). Drop `--enable-kb` if you don't want the
knowledge base.

**Via `npx`** (recommended — no install, always latest):

```json
{
  "mcpServers": {
    "memory-spaces": {
      "command": "npx",
      "args": ["-y", "memory-spaces", "--enable-kb"]
    }
  }
}
```

You can also run straight from GitHub without publishing:
`npx github:yourname/memory-spaces --enable-kb`.

**From a local checkout** (for development):

```bash
npm install
npm run build
```

```json
{
  "mcpServers": {
    "memory-spaces": {
      "command": "node",
      "args": ["/absolute/path/to/memory-spaces/dist/index.js", "--enable-kb"]
    }
  }
}
```

## Releasing

1. Add your changes under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md),
   then rename it to the new version with today's date and add a compare link.
2. Bump, tag, and push in one step (`preversion` builds, `postversion` pushes
   the commit + tag):

   ```bash
   npm version patch   # or: minor | major
   ```

3. Publish to npm:

   ```bash
   npm publish
   ```

## Roadmap

- [ ] Semantic recall (embeddings) behind the same `MemoryStore` interface
- [ ] Optional automatic memory extraction
- [ ] Per-space export / import
