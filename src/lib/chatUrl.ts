const HASH_PREFIX = "#chat/";

export function conversationIdFromUrl(): string | null {
  const hash = window.location.hash;
  if (!hash.startsWith(HASH_PREFIX)) return null;
  const id = hash.slice(HASH_PREFIX.length).split(/[/?#]/)[0]?.trim();
  return id || null;
}

export function setConversationUrl(id: string | null): void {
  const next = id ? `${HASH_PREFIX}${id}` : "";
  if (window.location.hash === next) return;
  const url = `${window.location.pathname}${window.location.search}${next}`;
  window.history.replaceState(null, "", url);
}

export function conversationUrl(id: string): string {
  return `${window.location.origin}${window.location.pathname}${window.location.search}${HASH_PREFIX}${id}`;
}

export function subscribeConversationUrl(handler: (id: string | null) => void): () => void {
  const onHashChange = () => handler(conversationIdFromUrl());
  window.addEventListener("hashchange", onHashChange);
  return () => window.removeEventListener("hashchange", onHashChange);
}
