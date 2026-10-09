import { isTauri } from "@tauri-apps/api/core";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { agentMarkdownTarget } from "../../lib/agentMarkdownLinks";
import { droppedImageMimeType } from "../../lib/agentComposer";
import { openAgentDocument, openUrl, readDroppedImage } from "../../lib/ipc";

export const AgentMarkdownWorkspace = createContext("");

export function AgentMarkdownLink({ href, title, children }: {
  href: string;
  title?: string;
  children: ReactNode;
}) {
  const cwd = useContext(AgentMarkdownWorkspace);
  const target = agentMarkdownTarget(href, cwd);
  const [error, setError] = useState<string | null>(null);
  if (!target) return <>{children}</>;
  if (target.kind === "file" && !isTauri()) {
    return <span title={target.path}>{children}</span>;
  }
  return <>
    <a href={target.kind === "web" ? target.href : href} title={title}
      target="_blank" rel="noreferrer"
      onClick={(event) => {
        if (target.kind === "web" && !isTauri()) return;
        event.preventDefault();
        setError(null);
        const opening = target.kind === "web" ? openUrl(target.href) : openAgentDocument(target.path);
        void opening.catch(() => setError("Could not open this link."));
      }}>{children}</a>
    {error && <span className="official-markdown-link-error" role="status">{error}</span>}
  </>;
}

export function AgentMarkdownImage({ src, alt, title }: {
  src: string;
  alt: string;
  title?: string;
}) {
  const cwd = useContext(AgentMarkdownWorkspace);
  const target = agentMarkdownTarget(src, cwd);
  const path = target?.kind === "file" ? target.path : null;
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!path || !isTauri()) return;
    const mime = droppedImageMimeType(path);
    if (!mime) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void readDroppedImage(path).then((bytes) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
      setLoaded({ path, url: objectUrl });
    }).catch(() => {
      if (!cancelled) setFailed(src);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, src]);
  const imageSrc = target?.kind === "web" ? target.href : loaded?.path === path ? loaded?.url : null;
  const label = alt || "Image preview";
  return <AgentMarkdownLink href={src} title={title}>
    {imageSrc && failed !== src
      ? <img className="official-markdown-image" src={imageSrc} alt={alt} title={title}
          loading="lazy" onError={() => setFailed(src)} />
      : <span className="official-markdown-image-fallback">{label}</span>}
  </AgentMarkdownLink>;
}
