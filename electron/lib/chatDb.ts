import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { join } from "path";
import { getDataDir } from "./config";
import type { ChatConversation, ChatMessage, ConversationMeta } from "../../shared/types";

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  const path = join(getDataDir(), "chat.db");
  try {
    db = new Database(path);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Cannot open chat database '${path}': ${msg}`);
  }
  if (db.readonly) {
    db.close();
    db = null;
    throw new Error(
      `Chat database is read-only: '${path}'. Fix ownership or set REVOLVER_DATA_DIR.`,
    );
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  initSchema(db);
  return db;
}

export function closeChatDb(): void {
  if (!db) return;
  db.close();
  db = null;
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model_id TEXT,
      model_path TEXT,
      model_display_name TEXT,
      backend_id TEXT,
      context_length INTEGER,
      n_gpu_layers INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      reasoning TEXT,
      created_at TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      tokens_per_second REAL,
      prompt_tokens_per_second REAL,
      ttft_ms REAL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_updated
      ON conversations(updated_at DESC);
  `);
  migrateSchema(database);
}

function migrateSchema(database: Database.Database): void {
  const cols = database.prepare(`PRAGMA table_info(conversations)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "server_id")) {
    database.exec(`ALTER TABLE conversations ADD COLUMN server_id TEXT`);
  }

  const msgCols = database.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
  if (!msgCols.some((c) => c.name === "prompt_tokens_per_second")) {
    database.exec(`ALTER TABLE messages ADD COLUMN prompt_tokens_per_second REAL`);
  }
  if (!msgCols.some((c) => c.name === "ttft_ms")) {
    database.exec(`ALTER TABLE messages ADD COLUMN ttft_ms REAL`);
  }
  if (!msgCols.some((c) => c.name === "reasoning")) {
    database.exec(`ALTER TABLE messages ADD COLUMN reasoning TEXT`);
  }
}

function rowToConversation(row: Record<string, unknown>): ChatConversation {
  return {
    id: String(row.id),
    title: String(row.title),
    modelId: row.model_id != null ? String(row.model_id) : null,
    modelPath: row.model_path != null ? String(row.model_path) : null,
    modelDisplayName: row.model_display_name != null ? String(row.model_display_name) : null,
    backendId: row.backend_id != null ? String(row.backend_id) : null,
    serverId: row.server_id != null ? String(row.server_id) : null,
    contextLength: row.context_length != null ? Number(row.context_length) : null,
    nGpuLayers: row.n_gpu_layers != null ? Number(row.n_gpu_layers) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: row.role as ChatMessage["role"],
    content: String(row.content),
    reasoning: row.reasoning != null ? String(row.reasoning) : null,
    createdAt: String(row.created_at),
    promptTokens: row.prompt_tokens != null ? Number(row.prompt_tokens) : null,
    completionTokens: row.completion_tokens != null ? Number(row.completion_tokens) : null,
    tokensPerSecond: row.tokens_per_second != null ? Number(row.tokens_per_second) : null,
    promptTokensPerSecond:
      row.prompt_tokens_per_second != null ? Number(row.prompt_tokens_per_second) : null,
    ttftMs: row.ttft_ms != null ? Number(row.ttft_ms) : null,
  };
}

export function listConversations(): ChatConversation[] {
  const rows = getDb()
    .prepare(`SELECT * FROM conversations ORDER BY updated_at DESC`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToConversation);
}

export function getConversation(id: string): ChatConversation | null {
  const row = getDb().prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToConversation(row) : null;
}

export function getMessages(conversationId: string): ChatMessage[] {
  const rows = getDb()
    .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`)
    .all(conversationId) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

export function createConversation(meta: ConversationMeta = {}): ChatConversation {
  const id = randomUUID();
  const now = new Date().toISOString();
  const title = meta.title?.trim() || "New chat";
  getDb()
    .prepare(
      `INSERT INTO conversations (
        id, title, model_id, model_path, model_display_name, backend_id, server_id,
        context_length, n_gpu_layers, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      title,
      meta.modelId ?? null,
      meta.modelPath ?? null,
      meta.modelDisplayName ?? null,
      meta.backendId ?? null,
      meta.serverId ?? null,
      meta.contextLength ?? null,
      meta.nGpuLayers ?? null,
      now,
      now,
    );
  return getConversation(id)!;
}

export function updateConversationTitle(id: string, title: string): ChatConversation | null {
  const now = new Date().toISOString();
  getDb()
    .prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`)
    .run(title.trim() || "New chat", now, id);
  return getConversation(id);
}

export function deleteConversation(id: string): void {
  getDb().prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
}

export function touchConversation(id: string): void {
  getDb()
    .prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

export function addMessage(
  conversationId: string,
  role: ChatMessage["role"],
  content: string,
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    tokensPerSecond?: number;
    promptTokensPerSecond?: number;
    ttftMs?: number;
    reasoning?: string | null;
  },
): ChatMessage {
  const id = randomUUID();
  const now = new Date().toISOString();
  const reasoning =
    usage?.reasoning != null && String(usage.reasoning).trim()
      ? String(usage.reasoning)
      : null;
  getDb()
    .prepare(
      `INSERT INTO messages (
        id, conversation_id, role, content, reasoning, created_at,
        prompt_tokens, completion_tokens, tokens_per_second,
        prompt_tokens_per_second, ttft_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      conversationId,
      role,
      content,
      reasoning,
      now,
      usage?.promptTokens ?? null,
      usage?.completionTokens ?? null,
      usage?.tokensPerSecond ?? null,
      usage?.promptTokensPerSecond ?? null,
      usage?.ttftMs ?? null,
    );
  touchConversation(conversationId);
  return rowToMessage(
    getDb().prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as Record<string, unknown>,
  );
}

export function autoTitleFromMessage(content: string): string {
  const line = content.trim().split("\n")[0] ?? "New chat";
  return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}

export function setConversationMeta(id: string, meta: ConversationMeta): void {
  const conv = getConversation(id);
  if (!conv) return;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE conversations SET
        model_id = COALESCE(?, model_id),
        model_path = COALESCE(?, model_path),
        model_display_name = COALESCE(?, model_display_name),
        backend_id = COALESCE(?, backend_id),
        server_id = COALESCE(?, server_id),
        context_length = COALESCE(?, context_length),
        n_gpu_layers = COALESCE(?, n_gpu_layers),
        updated_at = ?
      WHERE id = ?`,
    )
    .run(
      meta.modelId ?? null,
      meta.modelPath ?? null,
      meta.modelDisplayName ?? null,
      meta.backendId ?? null,
      meta.serverId ?? null,
      meta.contextLength ?? null,
      meta.nGpuLayers ?? null,
      now,
      id,
    );
}
