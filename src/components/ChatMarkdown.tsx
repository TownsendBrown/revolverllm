import { useCallback, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { Components } from "react-markdown";
import { preprocessMath } from "../lib/preprocessMath";
import "katex/dist/katex.min.css";

interface Props {
  content: string;
  className?: string;
}

function CodeBlock({ className, children }: { className?: string; children: string }) {
  const [copied, setCopied] = useState(false);
  const lang = className?.replace(/^language-/, "") ?? "";
  const text = children.replace(/\n$/, "");

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }, [text]);

  return (
    <div className="chat-code-block">
      {lang && (
        <div className="chat-code-head">
          <span>{lang}</span>
          <button type="button" className="chat-code-copy" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      <pre>
        <code className={className}>{text}</code>
      </pre>
    </div>
  );
}

const markdownComponents: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="chat-table-wrap">
      <table>{children}</table>
    </div>
  ),
  code: ({ className, children }) => {
    const text = String(children).replace(/\n$/, "");
    const isBlock = Boolean(className?.startsWith("language-")) || text.includes("\n");
    if (!isBlock) {
      return <code className="chat-inline-code">{children}</code>;
    }
    return <CodeBlock className={className}>{text}</CodeBlock>;
  },
  pre: ({ children }) => <>{children}</>,
};

const rehypePlugins = [
  [rehypeKatex, { throwOnError: false, strict: "ignore", trust: true }],
] as const;

export default function ChatMarkdown({ content, className = "" }: Props) {
  const processed = useMemo(() => preprocessMath(content), [content]);

  return (
    <div className={`chat-md ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={rehypePlugins as never}
        components={markdownComponents}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}
