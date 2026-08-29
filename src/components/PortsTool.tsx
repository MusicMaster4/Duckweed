import { useCallback, useEffect, useMemo, useState } from "react";

import {
  openUrl,
  portClose,
  portForward,
  portForwardStop,
  portsList,
  type AppPort,
} from "../lib/ipc";
import { AsciiAmbient } from "./AsciiAmbient";

interface Props {
  /** Process owners belonging to the visible tab, keyed by terminal id. */
  ownerNames: ReadonlyMap<string, string>;
  /** Reports every scan so activity outside the mounted tool stays visible. */
  onSnapshot?: (ports: readonly AppPort[]) => void;
}

function binding(port: AppPort): string {
  const address =
    port.address === "0.0.0.0" || port.address === "::" || port.address === "*"
      ? "all interfaces"
      : port.address;
  return `${address}:${port.port}`;
}

const localUrl = (port: AppPort) => `http://localhost:${port.port}`;

/** Keep the Ports tool scoped to the panes in the visible tab. */
export function portsForOwners(
  ports: readonly AppPort[],
  ownerNames: ReadonlyMap<string, string>,
): AppPort[] {
  return ports.filter((port) => ownerNames.has(port.owner_id));
}

function CopyButton({
  url,
  copied,
  onCopy,
}: {
  url: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <button
      type="button"
      className={`port-copy ${copied ? "is-copied" : ""}`}
      aria-label={`Copy ${url}`}
      title={copied ? "Copied" : "Copy address"}
      onClick={onCopy}
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
  );
}

/** One address line: the URL opens a browser, the button copies it. */
function AddressRow({
  url,
  label,
  copied,
  onCopy,
}: {
  url: string;
  label: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="port-address">
      <button
        type="button"
        className="port-url"
        title={`Open ${url} in the default browser`}
        onClick={() => void openUrl(url)}
      >
        <span>{label}</span>
        {url}
      </button>
      <CopyButton url={url} copied={copied} onCopy={onCopy} />
    </div>
  );
}

export function PortsTool({ ownerNames, onSnapshot }: Props) {
  const [ports, setPorts] = useState<AppPort[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const snapshot = await portsList();
      setPorts(snapshot.ports);
      onSnapshot?.(snapshot.ports);
      // Background polling must not erase an action failure before the user
      // has had a chance to read it. Explicit refreshes still clear stale
      // errors after a successful scan.
      if (!quiet) setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [onSnapshot]);

  useEffect(() => {
    let disposed = false;
    const poll = () => {
      if (!disposed) void refresh(true);
    };
    void refresh();
    const timer = window.setInterval(poll, 2500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
      setBusy(key);
      setError(null);
      try {
        await action();
        await refresh(true);
      } catch (reason) {
        setError(String(reason));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const copy = useCallback(async (id: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(id);
      window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1600);
    } catch {
      setError("Duckweed could not copy the address.");
    }
  }, []);

  const scopedPorts = useMemo(() => portsForOwners(ports, ownerNames), [ownerNames, ports]);
  const shared = useMemo(
    () => scopedPorts.filter((port) => port.forward).length,
    [scopedPorts],
  );

  return (
    <section className="ports-tool" aria-label="Application ports">
      <div className="tools-section-head ports-head">
        <div>
          <span className="tools-section-title">
            Ports
            {scopedPorts.length > 0 && <em className="ports-count">{scopedPorts.length}</em>}
          </span>
          <span className="tools-section-note">
            {shared > 0 ? `${shared} shared publicly` : "This tab's servers"}
          </span>
        </div>
        <button
          type="button"
          className={`ports-refresh ${loading ? "is-busy" : ""}`}
          aria-label="Rescan ports"
          title="Rescan ports"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M13 8a5 5 0 1 1-1.6-3.7" />
            <path d="M13 2.5V5h-2.6" />
          </svg>
        </button>
      </div>

      <div className="ports-scroll">
        {error && (
          <div className="ports-error" role="alert">
            <strong>Port action failed</strong>
            <span>{error}</span>
          </div>
        )}

        {!loading && scopedPorts.length === 0 && (
          <div className="tools-empty ports-empty">
            <AsciiAmbient surfaceId="ports-empty" scene="sonar" />
            <strong>Nothing is listening in this tab</strong>
            <p>Start a server in one of this tab's panes and it appears here.</p>
          </div>
        )}

        <div className="ports-list">
          {scopedPorts.map((port) => {
            const key = `${port.pid}:${port.port}`;
            const owner = ownerNames.get(port.owner_id);
            const isAgent = port.owner_kind === "agent";
            const isBusy = busy === key || busy === port.forward?.id;
            const isConfirming = confirming === key;
            return (
              <article className={`port-card ${port.forward ? "is-shared" : ""}`} key={key}>
                <header>
                  <span className="port-number">
                    <i aria-hidden="true" />
                    {port.port}
                  </span>
                  <span className="port-owner">
                    <strong>{owner ?? (isAgent ? "Agent" : "Terminal")}</strong>
                    <span>{port.process}</span>
                  </span>
                  {port.forward && <em className="port-badge">Shared</em>}
                </header>

                <div className="port-meta">
                  <span>{binding(port)}</span>
                  <span>PID {port.pid}</span>
                </div>

                <AddressRow
                  url={localUrl(port)}
                  label="Local"
                  copied={copied === key}
                  onCopy={() => void copy(key, localUrl(port))}
                />
                {port.forward && (
                  <AddressRow
                    url={port.forward.url}
                    label="Public"
                    copied={copied === port.forward.id}
                    onCopy={() => void copy(port.forward!.id, port.forward!.url)}
                  />
                )}

                <div className="port-actions">
                  {port.forward ? (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() =>
                        void run(port.forward!.id, () => portForwardStop(port.forward!.id))
                      }
                    >
                      Stop sharing
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="port-primary"
                      disabled={isBusy}
                      onClick={() => void run(key, () => portForward(port.pid, port.port))}
                    >
                      {busy === key ? "Creating public link..." : "Share publicly"}
                    </button>
                  )}
                  {!isConfirming ? (
                    <button type="button" className="port-quiet" onClick={() => setConfirming(key)}>
                      Close
                    </button>
                  ) : (
                    <>
                      <button type="button" className="port-quiet" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="port-danger"
                        disabled={isBusy}
                        onClick={() => {
                          setConfirming(null);
                          void run(key, () => portClose(port.pid, port.port));
                        }}
                      >
                        Stop process
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        <p className="ports-network-note">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 2.5v3M3.5 13.5h9M4 9h8v4.5H4zM8 5.5L4 9M8 5.5L12 9" />
          </svg>
          Anyone with a public link can access that server over the internet. Stop sharing when
          access is no longer needed.
        </p>
      </div>
    </section>
  );
}
