import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
} from "node:fs/promises";

export interface Memory {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
}

export interface Document {
  id: string;
  title: string;
  tags: string[];
  createdAt: string;
  chunkCount: number;
}

export interface Chunk {
  id: string;
  docId: string;
  position: number;
  content: string;
  /** Reserved for semantic search; unused while retrieval is keyword-only. */
  vector?: number[];
}

/** A knowledge-base hit: the matching chunk plus the title of its source doc. */
export interface KnowledgeHit {
  chunk: Chunk;
  docTitle: string;
}

/**
 * Storage contract for the memory server. Everything the tools need goes
 * through this interface, so the JSON-file backend below can be swapped for
 * SQLite or a vector store later without touching the server code.
 */
export interface MemoryStore {
  // Space management
  getActiveSpace(): Promise<string>;
  setActiveSpace(name: string): Promise<void>;
  listSpaces(): Promise<string[]>;

  // Memories — atomic, curated facts
  remember(space: string, content: string, tags: string[]): Promise<Memory>;
  recall(space: string, query: string, limit: number): Promise<Memory[]>;
  forget(space: string, id: string): Promise<boolean>;

  // Knowledge base — ingested documents, chunked for passage retrieval
  addDocument(space: string, title: string, content: string, tags: string[]): Promise<Document>;
  searchKnowledge(space: string, query: string, limit: number): Promise<KnowledgeHit[]>;
  listDocuments(space: string): Promise<Document[]>;
  removeDocument(space: string, id: string): Promise<boolean>;
}

const DEFAULT_SPACE = "personal";
const CHUNK_TARGET_CHARS = 800;

/** A space name that is safe to use as a directory name. */
function normalizeSpace(name: string): string {
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (!clean) throw new Error(`Invalid space name: "${name}"`);
  return clean;
}

/** Score `text` by how many query terms it contains (case-insensitive). */
function keywordScore(text: string, terms: string[]): number {
  const haystack = text.toLowerCase();
  return terms.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0);
}

/**
 * Split a document into passage-sized chunks. Packs paragraphs greedily up to
 * a target size; hard-splits any single paragraph that exceeds it. No overlap
 * for now — overlap matters most for semantic search, which comes later.
 */
function chunkText(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer.trim()) chunks.push(buffer.trim());
    buffer = "";
  };

  for (const para of paragraphs) {
    if (para.length > CHUNK_TARGET_CHARS) {
      flush();
      for (let i = 0; i < para.length; i += CHUNK_TARGET_CHARS) {
        chunks.push(para.slice(i, i + CHUNK_TARGET_CHARS).trim());
      }
      continue;
    }
    if (buffer.length + para.length + 2 > CHUNK_TARGET_CHARS) flush();
    buffer += (buffer ? "\n\n" : "") + para;
  }
  flush();
  return chunks.length ? chunks : [text.trim()].filter(Boolean);
}

interface State {
  activeSpace: string;
}

/**
 * Local-first store: one directory per space holding separate files for
 * memories, knowledge-base documents, and chunks. Writes are atomic (temp file
 * + rename) so a crash mid-write can never corrupt a file.
 */
export class JsonMemoryStore implements MemoryStore {
  private readonly statePath: string;
  private readonly spacesDir: string;

  constructor(root = join(homedir(), ".memory-spaces")) {
    this.statePath = join(root, "state.json");
    this.spacesDir = join(root, "spaces");
  }

  // --- paths --------------------------------------------------------------

  private spaceDir(space: string): string {
    return join(this.spacesDir, normalizeSpace(space));
  }
  private memoriesPath(space: string): string {
    return join(this.spaceDir(space), "memories.json");
  }
  private documentsPath(space: string): string {
    return join(this.spaceDir(space), "documents.json");
  }
  private chunksPath(space: string): string {
    return join(this.spaceDir(space), "chunks.json");
  }

  private async ensureSpaceDir(space: string): Promise<void> {
    await mkdir(this.spaceDir(space), { recursive: true });
  }

  // --- low-level IO -------------------------------------------------------

  private async atomicWrite(path: string, data: unknown): Promise<void> {
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, path);
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (err: unknown) {
      if (isNotFound(err)) return fallback;
      throw err;
    }
  }

  private async readState(): Promise<State> {
    const s = await this.readJson<Partial<State>>(this.statePath, {});
    return { activeSpace: s.activeSpace ?? DEFAULT_SPACE };
  }

  // --- space management ---------------------------------------------------

  async getActiveSpace(): Promise<string> {
    return (await this.readState()).activeSpace;
  }

  async setActiveSpace(name: string): Promise<void> {
    const space = normalizeSpace(name);
    await mkdir(this.spacesDir, { recursive: true });
    await this.atomicWrite(this.statePath, { activeSpace: space } satisfies State);
  }

  async listSpaces(): Promise<string[]> {
    await mkdir(this.spacesDir, { recursive: true });
    const entries = await readdir(this.spacesDir, { withFileTypes: true });
    const spaces = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const active = await this.getActiveSpace();
    if (!spaces.includes(active)) spaces.push(active);
    return spaces.sort();
  }

  // --- memories -----------------------------------------------------------

  async remember(space: string, content: string, tags: string[]): Promise<Memory> {
    await this.ensureSpaceDir(space);
    const memories = await this.readJson<Memory[]>(this.memoriesPath(space), []);
    const memory: Memory = {
      id: randomUUID(),
      content,
      tags,
      createdAt: new Date().toISOString(),
    };
    memories.push(memory);
    await this.atomicWrite(this.memoriesPath(space), memories);
    return memory;
  }

  async recall(space: string, query: string, limit: number): Promise<Memory[]> {
    const memories = await this.readJson<Memory[]>(this.memoriesPath(space), []);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
      return [...memories]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    }
    return memories
      .map((m) => ({ m, score: keywordScore(`${m.content} ${m.tags.join(" ")}`, terms) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.m.createdAt.localeCompare(a.m.createdAt))
      .slice(0, limit)
      .map((s) => s.m);
  }

  async forget(space: string, id: string): Promise<boolean> {
    const memories = await this.readJson<Memory[]>(this.memoriesPath(space), []);
    const next = memories.filter((m) => m.id !== id);
    if (next.length === memories.length) return false;
    await this.atomicWrite(this.memoriesPath(space), next);
    return true;
  }

  // --- knowledge base -----------------------------------------------------

  async addDocument(
    space: string,
    title: string,
    content: string,
    tags: string[]
  ): Promise<Document> {
    await this.ensureSpaceDir(space);
    const [docs, chunks] = await Promise.all([
      this.readJson<Document[]>(this.documentsPath(space), []),
      this.readJson<Chunk[]>(this.chunksPath(space), []),
    ]);

    const pieces = chunkText(content);
    const docId = randomUUID();
    const newChunks: Chunk[] = pieces.map((text, i) => ({
      id: randomUUID(),
      docId,
      position: i,
      content: text,
    }));

    const doc: Document = {
      id: docId,
      title,
      tags,
      createdAt: new Date().toISOString(),
      chunkCount: newChunks.length,
    };

    docs.push(doc);
    chunks.push(...newChunks);
    // Write chunks first: an orphaned chunk set is recoverable, a doc with no
    // chunks is not.
    await this.atomicWrite(this.chunksPath(space), chunks);
    await this.atomicWrite(this.documentsPath(space), docs);
    return doc;
  }

  async searchKnowledge(space: string, query: string, limit: number): Promise<KnowledgeHit[]> {
    const [docs, chunks] = await Promise.all([
      this.readJson<Document[]>(this.documentsPath(space), []),
      this.readJson<Chunk[]>(this.chunksPath(space), []),
    ]);
    const titleById = new Map(docs.map((d) => [d.id, d.title]));
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    return chunks
      .map((chunk) => ({ chunk, score: keywordScore(chunk.content, terms) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({ chunk: s.chunk, docTitle: titleById.get(s.chunk.docId) ?? "(unknown)" }));
  }

  async listDocuments(space: string): Promise<Document[]> {
    const docs = await this.readJson<Document[]>(this.documentsPath(space), []);
    return [...docs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async removeDocument(space: string, id: string): Promise<boolean> {
    const [docs, chunks] = await Promise.all([
      this.readJson<Document[]>(this.documentsPath(space), []),
      this.readJson<Chunk[]>(this.chunksPath(space), []),
    ]);
    const nextDocs = docs.filter((d) => d.id !== id);
    if (nextDocs.length === docs.length) return false;
    const nextChunks = chunks.filter((c) => c.docId !== id);
    await this.atomicWrite(this.chunksPath(space), nextChunks);
    await this.atomicWrite(this.documentsPath(space), nextDocs);
    return true;
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
