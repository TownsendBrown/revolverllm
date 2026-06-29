import * as chatDb from "./chatDb";
import { loadRuntimeConfig } from "./runtimeConfig";
import type { ChatConversation, ChatMessage, ConversationMeta } from "../../shared/types";

export interface InferMetrics {
  promptTokens: number | null;
  completionTokens: number | null;
  tokensPerSecond: number | null;
  promptTokensPerSecond: number | null;
  ttftMs: number | null;
}

export type ChatInference = (
  messages: Array<{ role: string; content: string }>,
  onDelta?: (delta: string) => void,
) => Promise<{
  content: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  metrics?: InferMetrics;
}>;

/** Derive metrics when the inferencer didn't supply server-reported ones. */
function fallbackMetrics(
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  elapsedMs: number,
  content: string,
): InferMetrics {
  const completion =
    usage?.completion_tokens ?? (content ? Math.ceil(content.length / 4) : null);
  return {
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: completion,
    tokensPerSecond:
      completion != null && elapsedMs > 0
        ? Math.round((completion / elapsedMs) * 1000 * 10) / 10
        : null,
    promptTokensPerSecond: null,
    ttftMs: null,
  };
}

export function listConversations(): ChatConversation[] {
  return chatDb.listConversations();
}

export function getConversationWithMessages(id: string): {
  conversation: ChatConversation;
  messages: ChatMessage[];
} | null {
  const conversation = chatDb.getConversation(id);
  if (!conversation) return null;
  return { conversation, messages: chatDb.getMessages(id) };
}

export function createConversation(meta: ConversationMeta = {}): ChatConversation {
  return chatDb.createConversation(meta);
}

export function updateConversationMeta(id: string, meta: ConversationMeta): ChatConversation | null {
  chatDb.setConversationMeta(id, meta);
  return chatDb.getConversation(id);
}

export function deleteConversation(id: string): void {
  chatDb.deleteConversation(id);
}

export function renameConversation(id: string, title: string): ChatConversation | null {
  return chatDb.updateConversationTitle(id, title);
}

const conversationQueues = new Map<string, Promise<unknown>>();

function withConversationLock<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
  const prev = conversationQueues.get(conversationId) ?? Promise.resolve();
  const next = prev.then(task, task);
  conversationQueues.set(
    conversationId,
    next.catch(() => {}),
  );
  void next.finally(() => {
    if (conversationQueues.get(conversationId) === next) {
      conversationQueues.delete(conversationId);
    }
  });
  return next;
}

export async function sendMessage(
  conversationId: string,
  content: string,
  infer: ChatInference,
  meta?: ConversationMeta,
  onDelta?: (delta: string) => void,
): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage }> {
  return withConversationLock(conversationId, async () => {
    const conv = chatDb.getConversation(conversationId);
    if (!conv) throw new Error("Conversation not found");

    if (meta) chatDb.setConversationMeta(conversationId, meta);

    const history = chatDb.getMessages(conversationId);
    const isFirst = history.length === 0;

    const userMessage = chatDb.addMessage(conversationId, "user", content);
    if (isFirst) {
      chatDb.updateConversationTitle(conversationId, chatDb.autoTitleFromMessage(content));
    }

    const payload = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content },
    ];

    const startMs = Date.now();
    const result = await infer(payload, onDelta);
    const metrics =
      result.metrics ?? fallbackMetrics(result.usage, Date.now() - startMs, result.content);
    const assistantMessage = chatDb.addMessage(conversationId, "assistant", result.content, {
      promptTokens: metrics.promptTokens ?? undefined,
      completionTokens: metrics.completionTokens ?? undefined,
      tokensPerSecond: metrics.tokensPerSecond ?? undefined,
      promptTokensPerSecond: metrics.promptTokensPerSecond ?? undefined,
      ttftMs: metrics.ttftMs ?? undefined,
    });
    return { userMessage, assistantMessage };
  });
}

export function currentModelMeta(loaded?: {
  modelId?: string | null;
  modelPath?: string | null;
  backendId?: string | null;
  contextLength?: number | null;
  nGpuLayers?: number | null;
  serverId?: string | null;
  serverName?: string | null;
} | null): ConversationMeta {
  const rt = loadRuntimeConfig();
  const modelId = loaded?.modelId ?? rt.lastModelId;
  const modelPath = loaded?.modelPath ?? null;
  const display =
    modelPath?.split("/").pop() ?? modelId?.split("/").pop() ?? modelId ?? null;
  return {
    modelId: modelId ?? null,
    modelPath,
    modelDisplayName: display,
    backendId: loaded?.backendId ?? rt.backendId,
    serverId: loaded?.serverId ?? null,
    contextLength: loaded?.contextLength ?? rt.contextLength,
    nGpuLayers: loaded?.nGpuLayers ?? rt.nGpuLayers,
  };
}

export function metaFromServer(loaded: {
  modelId: string;
  modelPath: string;
  backendId: string;
  contextLength: number;
  nGpuLayers: number;
  serverId?: string;
  serverName?: string;
}): ConversationMeta {
  return currentModelMeta(loaded);
}
