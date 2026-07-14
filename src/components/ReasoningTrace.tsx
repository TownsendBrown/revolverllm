import { useState } from "react";

interface Props {
  reasoning: string;
  /** Keep open while the model is still thinking / streaming. */
  streaming?: boolean;
}

/** Collapsible panel for model chain-of-thought / reasoning traces. */
export default function ReasoningTrace({ reasoning, streaming = false }: Props) {
  const [open, setOpen] = useState(streaming);

  if (!reasoning && !streaming) return null;

  return (
    <details
      className="chat-reasoning"
      open={streaming ? true : open}
      onToggle={(e) => {
        if (streaming) return;
        setOpen((e.target as HTMLDetailsElement).open);
      }}
    >
      <summary className="chat-reasoning-summary">
        {streaming && !reasoning ? "Thinking…" : "Thinking"}
      </summary>
      {reasoning ? (
        <pre className="chat-reasoning-body">{reasoning}</pre>
      ) : (
        <span className="dot-pulse" />
      )}
    </details>
  );
}
