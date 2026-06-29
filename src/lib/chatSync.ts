export type ChatSyncEvent =
  | { type: "conversation:created"; conversationId: string; tabId: string }
  | { type: "conversation:deleted"; conversationId: string; tabId: string }
  | { type: "conversation:updated"; conversationId: string; tabId: string }
  | { type: "conversation:messages:start"; conversationId: string; tabId: string }
  | { type: "conversation:messages:complete"; conversationId: string; tabId: string };

const CHANNEL_NAME = "revolver-chat";
const STORAGE_KEY = "revolver-chat-sync";

const tabId =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function getChatTabId(): string {
  return tabId;
}

function isOwnTab(event: ChatSyncEvent): boolean {
  return event.tabId === tabId;
}

function dispatch(event: ChatSyncEvent, handler: (event: ChatSyncEvent) => void): void {
  if (isOwnTab(event)) return;
  handler(event);
}

export function publishChatEvent(event: Omit<ChatSyncEvent, "tabId">): void {
  const full = { ...event, tabId } as ChatSyncEvent;

  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(CHANNEL_NAME);
      channel.postMessage(full);
      channel.close();
    } catch {
      // ignore — storage fallback below
    }
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...full, _ts: Date.now() }));
  } catch {
    // private browsing or quota exceeded
  }
}

export function subscribeChatEvents(handler: (event: ChatSyncEvent) => void): () => void {
  let channel: BroadcastChannel | null = null;

  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (ev: MessageEvent<ChatSyncEvent>) => {
        if (ev.data?.type && ev.data?.tabId) dispatch(ev.data, handler);
      };
    } catch {
      channel = null;
    }
  }

  const onStorage = (ev: StorageEvent) => {
    if (ev.key !== STORAGE_KEY || !ev.newValue) return;
    try {
      const parsed = JSON.parse(ev.newValue) as ChatSyncEvent & { _ts?: number };
      const { _ts: _, ...event } = parsed;
      if (event.type && event.tabId) dispatch(event as ChatSyncEvent, handler);
    } catch {
      // ignore malformed payload
    }
  };

  window.addEventListener("storage", onStorage);

  return () => {
    channel?.close();
    window.removeEventListener("storage", onStorage);
  };
}
