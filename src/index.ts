#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JsonMemoryStore, type Memory, type KnowledgeHit } from "./store.js";

const store = new JsonMemoryStore();

const server = new McpServer({
  name: "memory-spaces",
  version: "0.1.0",
});

/**
 * Knowledge-base tools are gated behind a feature flag and off by default.
 * Enable with the env var MEMORY_SPACES_ENABLE_KB (1/true/yes/on) or the
 * --enable-kb CLI flag. When disabled, the KB tools are never registered, so
 * they don't appear to the client at all.
 */
function isKbEnabled(): boolean {
  if (process.argv.includes("--enable-kb")) return true;
  const env = (process.env.MEMORY_SPACES_ENABLE_KB ?? "").trim().toLowerCase();
  return env === "1" || env === "true" || env === "yes" || env === "on";
}

const KB_ENABLED = isKbEnabled();

/** Render a memory for display, always stamped with its space for provenance. */
function formatMemory(space: string, m: Memory): string {
  const tags = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
  return `[space: ${space}] (${m.id})${tags}\n${m.content}`;
}

/** Render a knowledge-base hit, stamped with its space and source document. */
function formatHit(space: string, hit: KnowledgeHit): string {
  return `[space: ${space}] from "${hit.docTitle}" (chunk ${hit.chunk.id})\n${hit.chunk.content}`;
}

// --- Global tools (not scoped to a space) ---------------------------------

server.registerTool(
  "list_spaces",
  {
    title: "List spaces",
    description:
      "List all memory spaces and indicate which one is currently active.",
    inputSchema: {},
  },
  async () => {
    const [spaces, active] = await Promise.all([
      store.listSpaces(),
      store.getActiveSpace(),
    ]);
    const lines = spaces.map((s) => (s === active ? `* ${s} (active)` : `  ${s}`));
    return { content: [{ type: "text", text: lines.join("\n") || "No spaces yet." }] };
  }
);

server.registerTool(
  "current_space",
  {
    title: "Current space",
    description: "Report which memory space is currently active.",
    inputSchema: {},
  },
  async () => {
    const active = await store.getActiveSpace();
    return { content: [{ type: "text", text: `Active space: ${active}` }] };
  }
);

server.registerTool(
  "switch_space",
  {
    title: "Switch space",
    description:
      "Set the active memory space, creating it if it does not exist. " +
      "All subsequent remember/recall/forget calls apply only to this space.",
    inputSchema: {
      name: z.string().describe("The space to switch to, e.g. 'work' or 'personal'."),
    },
  },
  async ({ name }) => {
    await store.setActiveSpace(name);
    const active = await store.getActiveSpace();
    return {
      content: [
        {
          type: "text",
          text:
            `Switched to "${active}". Memories from other spaces are no longer ` +
            `accessible until you switch again.`,
        },
      ],
    };
  }
);

// --- Active-space tools ----------------------------------------------------

server.registerTool(
  "remember",
  {
    title: "Remember",
    description:
      "Store a memory in the ACTIVE space. Use only for things the user " +
      "explicitly asks to remember.",
    inputSchema: {
      content: z.string().describe("The fact or note to remember."),
      tags: z.array(z.string()).optional().describe("Optional labels for retrieval."),
    },
  },
  async ({ content, tags }) => {
    const space = await store.getActiveSpace();
    const memory = await store.remember(space, content, tags ?? []);
    return {
      content: [{ type: "text", text: `Remembered in "${space}" (${memory.id}).` }],
    };
  }
);

server.registerTool(
  "recall",
  {
    title: "Recall",
    description:
      "Search memories in the ACTIVE space. Returns the best keyword matches, " +
      "or the most recent memories if no query is given.",
    inputSchema: {
      query: z.string().optional().describe("What to search for."),
      limit: z.number().int().positive().max(50).optional().describe("Max results (default 10)."),
    },
  },
  async ({ query, limit }) => {
    const space = await store.getActiveSpace();
    const results = await store.recall(space, query ?? "", limit ?? 10);
    if (results.length === 0) {
      return { content: [{ type: "text", text: `[space: ${space}] No matching memories.` }] };
    }
    return {
      content: [{ type: "text", text: results.map((m) => formatMemory(space, m)).join("\n\n") }],
    };
  }
);

server.registerTool(
  "forget",
  {
    title: "Forget",
    description: "Delete a memory by id from the ACTIVE space.",
    inputSchema: {
      id: z.string().describe("The id of the memory to delete (shown by recall)."),
    },
  },
  async ({ id }) => {
    const space = await store.getActiveSpace();
    const removed = await store.forget(space, id);
    return {
      content: [
        {
          type: "text",
          text: removed
            ? `Forgot ${id} from "${space}".`
            : `No memory ${id} found in "${space}".`,
        },
      ],
    };
  }
);

// --- Knowledge-base tools (active space only, gated by KB_ENABLED) ---------

if (KB_ENABLED) {
server.registerTool(
  "add_document",
  {
    title: "Add document",
    description:
      "Ingest a document into the ACTIVE space's knowledge base. The text is " +
      "split into passages for retrieval via search_knowledge.",
    inputSchema: {
      title: z.string().describe("A name for the document."),
      content: z.string().describe("The full document text."),
      tags: z.array(z.string()).optional().describe("Optional labels."),
    },
  },
  async ({ title, content, tags }) => {
    const space = await store.getActiveSpace();
    const doc = await store.addDocument(space, title, content, tags ?? []);
    return {
      content: [
        {
          type: "text",
          text: `Added "${doc.title}" to "${space}" (${doc.chunkCount} chunk(s), id ${doc.id}).`,
        },
      ],
    };
  }
);

server.registerTool(
  "search_knowledge",
  {
    title: "Search knowledge",
    description:
      "Search the ACTIVE space's knowledge base and return the most relevant " +
      "passages. Use this for reference material, distinct from recall (facts).",
    inputSchema: {
      query: z.string().describe("What to search for."),
      limit: z.number().int().positive().max(50).optional().describe("Max passages (default 5)."),
    },
  },
  async ({ query, limit }) => {
    const space = await store.getActiveSpace();
    const hits = await store.searchKnowledge(space, query, limit ?? 5);
    if (hits.length === 0) {
      return { content: [{ type: "text", text: `[space: ${space}] No matching passages.` }] };
    }
    return {
      content: [{ type: "text", text: hits.map((h) => formatHit(space, h)).join("\n\n") }],
    };
  }
);

server.registerTool(
  "list_documents",
  {
    title: "List documents",
    description: "List the documents in the ACTIVE space's knowledge base.",
    inputSchema: {},
  },
  async () => {
    const space = await store.getActiveSpace();
    const docs = await store.listDocuments(space);
    if (docs.length === 0) {
      return { content: [{ type: "text", text: `[space: ${space}] No documents.` }] };
    }
    const lines = docs.map((d) => {
      const tags = d.tags.length ? ` [${d.tags.join(", ")}]` : "";
      return `${d.id}  ${d.title}${tags} — ${d.chunkCount} chunk(s)`;
    });
    return { content: [{ type: "text", text: `[space: ${space}]\n${lines.join("\n")}` }] };
  }
);

server.registerTool(
  "remove_document",
  {
    title: "Remove document",
    description: "Delete a document and its passages from the ACTIVE space's knowledge base.",
    inputSchema: {
      id: z.string().describe("The document id (shown by list_documents)."),
    },
  },
  async ({ id }) => {
    const space = await store.getActiveSpace();
    const removed = await store.removeDocument(space, id);
    return {
      content: [
        {
          type: "text",
          text: removed
            ? `Removed document ${id} from "${space}".`
            : `No document ${id} found in "${space}".`,
        },
      ],
    };
  }
);
} // end KB_ENABLED

// --- Boot ------------------------------------------------------------------

async function main() {
  console.error(
    `memory-spaces: knowledge base ${KB_ENABLED ? "enabled" : "disabled"}` +
      (KB_ENABLED ? "" : " (set MEMORY_SPACES_ENABLE_KB=1 or pass --enable-kb to enable)")
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("memory-spaces server failed to start:", err);
  process.exit(1);
});
