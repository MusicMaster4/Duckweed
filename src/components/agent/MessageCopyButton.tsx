import { useEffect, useState } from "react";

import "./MessageCopyButton.css";

interface MessageCopyButtonProps {
  text: string;
}

async function writeText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Some embedded webviews expose the Clipboard API but reject the write.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

export function MessageCopyButton({ text }: MessageCopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const copy = async () => {
    if (await writeText(text)) {
      setCopied(true);
    } else {
      setCopied(false);
    }
  };

  return (
    <div className="agent-message-actions">
      <button
        type="button"
        className={`agent-message-copy${copied ? " is-copied" : ""}`}
        aria-label={copied ? "Message copied" : "Copy message"}
        title={copied ? "Copied" : "Copy message"}
        onClick={() => void copy()}
      >
        {copied ? (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 8.5l3 3 6-6.5" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="6" y="6" width="7.5" height="7.5" rx="1.5" />
            <path d="M10 6V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v4.5A1.5 1.5 0 0 0 4 10h2" />
          </svg>
        )}
      </button>
    </div>
  );
}
