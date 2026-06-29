import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type ChatConversation,
  type ChatMessage,
  type ConversationMeta,
  type ServerInstanceStatus,
  type ServerStatus,
} from "../revolver";
import { publishChatEvent, subscribeChatEvents, type ChatSyncEvent } from "../lib/chatSync";
import {
  conversationIdFromUrl,
  conversationUrl,
  setConversationUrl,
  subscribeConversationUrl,
} from "../lib/chatUrl";
import ChatMarkdown from "./ChatMarkdown";

interface Props {
  serverStatus: ServerStatus | null;
  onError: (msg: string) => void;
}

function formatRelative(iso: string) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

function formatTtft(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function metaFromServer(s: ServerInstanceStatus): ConversationMeta {
  const loaded = s.loaded;
  const def = s.definition;
  return {
    serverId: def.id,
    modelId: loaded?.modelId ?? def.modelId,
    modelPath: loaded?.modelPath ?? def.modelPath,
    modelDisplayName: def.name,
    backendId: def.backend,
    contextLength: def.contextLength,
    nGpuLayers: def.nGpuLayers,
  };
}

export default function ChatPanel({ serverStatus, onError }: Props) {
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => conversationIdFromUrl());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeConv, setActiveConv] = useState<ChatConversation | null>(null);
  const [runningServers, setRunningServers] = useState<ServerInstanceStatus[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string>("");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [remoteGenerating, setRemoteGenerating] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeIdRef = useRef<string | null>(activeId);
  const sendingRef = useRef(false);
  const remoteGenRef = useRef(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const loadSeqRef = useRef(0);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);

  useEffect(() => {
    remoteGenRef.current = remoteGenerating;
  }, [remoteGenerating]);

  const refreshServers = useCallback(async () => {
    try {
      const list = await api.listServers();
      const running = list.filter((s) => s.running && s.loadPhase !== "loading");
      setRunningServers(running);
      return running;
    } catch (e) {
      onError(String(e));
      return [];
    }
  }, [onError]);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    try {
      const list = await api.listConversations();
      setConversations(list);
    } catch (e) {
      onError(String(e));
    } finally {
      setLoadingList(false);
    }
  }, [onError]);

  const loadThread = useCallback(
    async (id: string, opts?: { silent?: boolean }) => {
      const seq = ++loadSeqRef.current;
      if (!opts?.silent) setLoadingThread(true);
      try {
        const detail = await api.getConversation(id);
        if (loadSeqRef.current !== seq || activeIdRef.current !== id) return;
        setActiveConv(detail.conversation);
        if (!sendingRef.current) {
          setMessages(detail.messages);
        }
        if (detail.conversation.serverId) {
          setSelectedServerId(detail.conversation.serverId);
        }
      } catch (e) {
        if (loadSeqRef.current === seq) onError(String(e));
      } finally {
        if (loadSeqRef.current === seq && !opts?.silent) setLoadingThread(false);
      }
    },
    [onError],
  );

  const abortStream = useCallback(() => {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
  }, []);

  const switchConversation = useCallback(
    (id: string | null) => {
      abortStream();
      loadSeqRef.current += 1;
      activeIdRef.current = id;
      setActiveId(id);
      setRemoteGenerating(false);
      if (!id) {
        setActiveConv(null);
        setMessages([]);
        return;
      }
      loadThread(id).catch((e) => onError(String(e)));
    },
    [abortStream, loadThread, onError],
  );

  const refreshActiveThread = useCallback(
    async (opts?: { silent?: boolean }) => {
      const id = activeIdRef.current;
      if (!id || sendingRef.current) return;
      await loadThread(id, opts);
    },
    [loadThread],
  );

  const handleSyncEvent = useCallback(
    (event: ChatSyncEvent) => {
      switch (event.type) {
        case "conversation:created":
        case "conversation:updated":
          loadList().catch(() => {});
          if (event.conversationId === activeIdRef.current) {
            refreshActiveThread({ silent: true }).catch(() => {});
          }
          break;
        case "conversation:deleted":
          setConversations((prev) => prev.filter((c) => c.id !== event.conversationId));
          if (activeIdRef.current === event.conversationId) {
            abortStream();
            loadSeqRef.current += 1;
            activeIdRef.current = null;
            setActiveId(null);
            setActiveConv(null);
            setMessages([]);
            setRemoteGenerating(false);
            setConversationUrl(null);
          }
          break;
        case "conversation:messages:start":
          if (event.conversationId === activeIdRef.current) {
            setRemoteGenerating(true);
          }
          loadList().catch(() => {});
          break;
        case "conversation:messages:complete":
          if (event.conversationId === activeIdRef.current) {
            setRemoteGenerating(false);
            refreshActiveThread({ silent: true }).catch(() => {});
          } else {
            loadList().catch(() => {});
          }
          break;
      }
    },
    [loadList, refreshActiveThread, abortStream],
  );

  useEffect(() => {
    loadList().catch((e) => onError(String(e)));
    refreshServers().catch((e) => onError(String(e)));

    const urlId = conversationIdFromUrl();
    if (urlId) {
      loadThread(urlId).catch((e) => onError(String(e)));
    }
  }, [loadList, refreshServers, loadThread, onError]);

  useEffect(() => {
    return subscribeChatEvents(handleSyncEvent);
  }, [handleSyncEvent]);

  useEffect(() => {
    return subscribeConversationUrl((id) => {
      if (id === activeIdRef.current) return;
      switchConversation(id);
    });
  }, [switchConversation]);

  useEffect(() => {
    const urlId = conversationIdFromUrl();
    if (activeId === urlId) return;
    setConversationUrl(activeId);
  }, [activeId]);

  useEffect(() => {
    const t = setInterval(() => {
      refreshServers().catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [refreshServers]);

  useEffect(() => {
    const poll = () => {
      if (document.hidden) return;
      loadList().catch(() => {});
      if (activeIdRef.current && !sendingRef.current) {
        refreshActiveThread({ silent: true }).catch(() => {});
      }
    };
    const intervalMs =
      !sending &&
      messages.length > 0 &&
      messages[messages.length - 1]?.role === "user" &&
      serverStatus?.generation?.stage === "generating"
        ? 1500
        : 5000;
    const t = setInterval(poll, intervalMs);
    return () => clearInterval(t);
  }, [loadList, refreshActiveThread, serverStatus?.generation?.stage, messages, sending]);

  useEffect(() => {
    if (selectedServerId && runningServers.some((s) => s.definition.id === selectedServerId)) {
      return;
    }
    const fromConv = activeConv?.serverId;
    if (fromConv && runningServers.some((s) => s.definition.id === fromConv)) {
      setSelectedServerId(fromConv);
      return;
    }
    if (runningServers[0]) setSelectedServerId(runningServers[0].definition.id);
    else setSelectedServerId("");
  }, [runningServers, activeConv?.serverId, selectedServerId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending, remoteGenerating]);

  const selectedServer = runningServers.find((s) => s.definition.id === selectedServerId) ?? null;

  const pickServer = async (serverId: string) => {
    setSelectedServerId(serverId);
    if (!activeId) return;
    try {
      const server = runningServers.find((s) => s.definition.id === serverId);
      if (!server) return;
      const updated = await api.updateConversationMeta(activeId, metaFromServer(server));
      setActiveConv(updated);
      setConversations((prev) => prev.map((c) => (c.id === activeId ? updated : c)));
      publishChatEvent({ type: "conversation:updated", conversationId: activeId });
    } catch (e) {
      onError(String(e));
    }
  };

  const newChat = async () => {
    try {
      abortStream();
      const meta = selectedServer ? metaFromServer(selectedServer) : {};
      const conv = await api.createConversation(meta);
      setConversations((prev) => [conv, ...prev]);
      activeIdRef.current = conv.id;
      setActiveId(conv.id);
      setActiveConv(conv);
      setMessages([]);
      setRemoteGenerating(false);
      publishChatEvent({ type: "conversation:created", conversationId: conv.id });
      textareaRef.current?.focus();
    } catch (e) {
      onError(String(e));
    }
  };

  const selectConv = (id: string) => {
    if (id === activeId) return;
    switchConversation(id);
  };

  const openInNewTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(conversationUrl(id), "_blank", "noopener,noreferrer");
  };

  const deleteConv = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      publishChatEvent({ type: "conversation:deleted", conversationId: id });
      if (activeId === id) {
        switchConversation(null);
      }
    } catch (err) {
      onError(String(err));
    }
  };

  const startRename = (conv: ChatConversation, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(conv.id);
    setEditTitle(conv.title);
  };

  const commitRename = async (id: string) => {
    const title = editTitle.trim();
    setEditingId(null);
    if (!title) return;
    try {
      const updated = await api.renameConversation(id, title);
      setConversations((prev) => prev.map((c) => (c.id === id ? updated : c)));
      if (activeId === id) setActiveConv(updated);
      publishChatEvent({ type: "conversation:updated", conversationId: id });
    } catch (e) {
      onError(String(e));
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    if (!selectedServerId || !selectedServer) {
      onError("Select a running server first.");
      return;
    }

    setSending(true);
    setRemoteGenerating(false);
    setInput("");
    onError("");

    const abort = new AbortController();
    streamAbortRef.current = abort;

    let convId = activeId;
    const streamId = `stream-${Date.now()}`;

    try {
      if (!convId) {
        const conv = await api.createConversation(metaFromServer(selectedServer));
        convId = conv.id;
        activeIdRef.current = conv.id;
        setActiveId(conv.id);
        setActiveConv(conv);
        setConversations((prev) => [conv, ...prev]);
        publishChatEvent({ type: "conversation:created", conversationId: conv.id });
      }

      publishChatEvent({ type: "conversation:messages:start", conversationId: convId });

      const optimisticUser: ChatMessage = {
        id: `tmp-user-${Date.now()}`,
        conversationId: convId,
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
        promptTokens: null,
        completionTokens: null,
        tokensPerSecond: null,
        promptTokensPerSecond: null,
        ttftMs: null,
      };
      const streamingAssistant: ChatMessage = {
        id: streamId,
        conversationId: convId,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
        promptTokens: null,
        completionTokens: null,
        tokensPerSecond: null,
        promptTokensPerSecond: null,
        ttftMs: null,
      };
      setMessages((prev) => [...prev, optimisticUser, streamingAssistant]);

      const result = await api.sendMessage(convId, text, {
        serverId: selectedServerId,
        signal: abort.signal,
        onDelta: (delta) => {
          if (activeIdRef.current !== convId) return;
          setMessages((prev) =>
            prev.map((m) => (m.id === streamId ? { ...m, content: m.content + delta } : m)),
          );
        },
      });

      if (activeIdRef.current !== convId) return;

      setMessages((prev) => [
        ...prev.filter((m) => m.id !== optimisticUser.id && m.id !== streamId),
        result.userMessage,
        result.assistantMessage,
      ]);

      const list = await api.listConversations();
      setConversations(list);
      const detail = await api.getConversation(convId);
      setActiveConv(detail.conversation);
      publishChatEvent({ type: "conversation:messages:complete", conversationId: convId });
    } catch (e) {
      if (abort.signal.aborted) return;
      const errMsg = String(e);
      const networkLost =
        e instanceof TypeError ||
        errMsg.includes("NetworkError") ||
        errMsg.includes("Failed to fetch") ||
        errMsg.includes("Connection lost while streaming") ||
        errMsg.includes("Stream ended without result");
      if (networkLost && convId && activeIdRef.current === convId) {
        try {
          const detail = await api.getConversation(convId);
          if (activeIdRef.current === convId) {
            setActiveConv(detail.conversation);
            setMessages(detail.messages);
            const lastRole = detail.messages[detail.messages.length - 1]?.role;
            onError(
              lastRole === "user"
                ? "Connection lost — still generating. Reply will appear shortly."
                : "",
            );
          }
        } catch {
          onError("Connection lost — still generating. Reply will appear shortly.");
        }
        publishChatEvent({ type: "conversation:messages:complete", conversationId: convId });
        return;
      }
      if (convId && activeIdRef.current === convId) {
        await loadThread(convId, { silent: true }).catch(() => {});
      }
      if (convId) {
        publishChatEvent({ type: "conversation:messages:complete", conversationId: convId });
      }
      onError(errMsg);
      setInput(text);
    } finally {
      if (streamAbortRef.current === abort) streamAbortRef.current = null;
      setSending(false);
    }
  };

  const modelLabel =
    selectedServer?.definition.name ??
    activeConv?.modelDisplayName ??
    serverStatus?.loaded?.modelId?.split("/").pop() ??
    null;

  const canSend = !!selectedServerId && runningServers.length > 0;
  const awaitingReply =
    !sending &&
    messages.length > 0 &&
    messages[messages.length - 1]?.role === "user" &&
    serverStatus?.generation?.stage === "generating";
  const inputLocked = !canSend || sending || remoteGenerating || awaitingReply;

  return (
    <div className="chat-shell">
      <aside className="chat-sidebar">
        <button className="chat-new-btn" onClick={newChat} disabled={!canSend}>
          + New chat
        </button>
        <div className="chat-conv-list">
          {loadingList && conversations.length === 0 && (
            <p className="chat-empty muted">Loading…</p>
          )}
          {!loadingList && conversations.length === 0 && (
            <p className="chat-empty muted">No conversations yet</p>
          )}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`chat-conv-item ${c.id === activeId ? "active" : ""}`}
              onClick={() => selectConv(c.id)}
            >
              {editingId === c.id ? (
                <input
                  className="chat-rename-input"
                  value={editTitle}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={() => commitRename(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(c.id);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <>
                  <span className="chat-conv-title" title={c.title}>
                    {c.title}
                  </span>
                  <span className="chat-conv-meta">
                    {c.modelDisplayName && (
                      <span className="chat-conv-model">{c.modelDisplayName}</span>
                    )}
                    <span>{formatRelative(c.updatedAt)}</span>
                  </span>
                </>
              )}
              <div className="chat-conv-actions">
                <button
                  type="button"
                  className="chat-icon-btn"
                  title="Open in new tab"
                  onClick={(e) => openInNewTab(c.id, e)}
                >
                  ↗
                </button>
                <button
                  type="button"
                  className="chat-icon-btn"
                  title="Rename"
                  onClick={(e) => startRename(c, e)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="chat-icon-btn danger"
                  title="Delete"
                  onClick={(e) => deleteConv(c.id, e)}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      </aside>

      <div className="chat-main">
        <header className="chat-header">
          <h2>{activeConv?.title ?? "New chat"}</h2>
          <div className="chat-header-controls">
            {runningServers.length > 0 ? (
              <label className="chat-server-select">
                <span className="muted small">Model</span>
                <select
                  value={selectedServerId}
                  disabled={sending}
                  onChange={(e) => pickServer(e.target.value)}
                >
                  {runningServers.map((s) => (
                    <option key={s.definition.id} value={s.definition.id}>
                      {s.definition.name} · {s.definition.backend.toUpperCase()} · :{s.definition.hostPort}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="chat-offline muted">No server running</span>
            )}
            {modelLabel && <span className="chat-model-badge">{modelLabel}</span>}
          </div>
        </header>

        {awaitingReply && (
          <div className="chat-remote-banner muted">
            Generating response…
          </div>
        )}

        {remoteGenerating && !sending && !awaitingReply && (
          <div className="chat-remote-banner muted">
            Generating in another tab…
          </div>
        )}

        <div className="chat-messages">
          {loadingThread && <p className="muted center">Loading messages…</p>}
          {!loadingThread && messages.length === 0 && (
            <div className="chat-welcome">
              <h3>What can I help with?</h3>
              <p className="muted">
                {canSend
                  ? "Pick a live server above and start typing. Output streams as it generates."
                  : "Start a server on the Server tab, then come back here."}
              </p>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`chat-msg ${m.role}`}>
              <div className="chat-msg-avatar">{m.role === "user" ? "You" : "AI"}</div>
              <div className="chat-msg-body">
                {m.role === "assistant" ? (
                  <>
                    {m.content ? (
                      <ChatMarkdown content={m.content} />
                    ) : (
                      <span className="dot-pulse" />
                    )}
                    {m.id.startsWith("stream-") && sending && m.content && (
                      <span className="chat-stream-cursor" />
                    )}
                  </>
                ) : (
                  <div className="chat-user-text">{m.content}</div>
                )}
                {m.role === "assistant" && m.completionTokens != null && !m.id.startsWith("stream-") && (
                  <span className="chat-msg-stats">
                    {m.completionTokens} tok
                    {m.tokensPerSecond != null && ` · ${m.tokensPerSecond} t/s`}
                    {m.promptTokens != null && ` · ${m.promptTokens} prompt`}
                    {m.promptTokensPerSecond != null && ` @ ${m.promptTokensPerSecond} t/s`}
                    {m.ttftMs != null && ` · TTFT ${formatTtft(m.ttftMs)}`}
                  </span>
                )}
              </div>
            </div>
          ))}
          {awaitingReply && (
            <div className="chat-msg assistant">
              <div className="chat-msg-avatar">AI</div>
              <div className="chat-msg-body">
                <span className="dot-pulse" />
              </div>
            </div>
          )}
          {remoteGenerating && !sending && !awaitingReply && messages.length > 0 && (
            <div className="chat-msg assistant">
              <div className="chat-msg-avatar">AI</div>
              <div className="chat-msg-body">
                <span className="dot-pulse" />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="chat-composer">
          <textarea
            ref={textareaRef}
            value={input}
            rows={1}
            placeholder={
              remoteGenerating
                ? "Waiting for other tab…"
                : awaitingReply
                  ? "Generating response…"
                  : canSend
                    ? "Message…"
                    : "Start a server to chat"
            }
            disabled={inputLocked}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            className="primary chat-send-btn"
            disabled={inputLocked || !input.trim()}
            onClick={send}
          >
            {sending ? "…" : "↑"}
          </button>
        </div>
      </div>
    </div>
  );
}
