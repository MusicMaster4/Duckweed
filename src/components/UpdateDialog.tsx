import { useEffect } from "react";

import type { Updater } from "../hooks/useUpdater";

const CHANNEL_BLURB = {
  stable: "Stable builds only. Beta releases are never offered here.",
  testing: "Beta builds only. Stable releases are never offered here.",
} as const;

export function UpdateDialog({ updater }: { updater: Updater }) {
  const { status, version, channel, close, install } = updater;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [close]);

  const percent =
    status.kind === "installing" && status.fraction !== null
      ? Math.round(status.fraction * 100)
      : null;

  return (
    <div className="palette-backdrop" onPointerDown={close}>
      <div className="update-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <header className="update-head">
          <span className="update-title">Updates</span>
          <span className={`update-channel is-${channel}`}>{channel === "testing" ? "beta" : "stable"}</span>
          <span className="update-current">v{version || "?"}</span>
        </header>

        <div className="update-body">
          {status.kind === "checking" && <p className="update-line">Checking for updates…</p>}

          {status.kind === "current" && (
            <>
              <p className="update-line">Duckweed is up to date.</p>
              <p className="update-note">{CHANNEL_BLURB[channel]}</p>
            </>
          )}

          {status.kind === "available" && (
            <>
              <p className="update-line">
                Version <strong>{status.update.version}</strong> is available.
              </p>
              {status.update.notes && <pre className="update-notes">{status.update.notes.trim()}</pre>}
              <p className="update-note">
                Installs without asking for administrator rights, then restarts Duckweed.
              </p>
            </>
          )}

          {status.kind === "installing" && (
            <>
              <p className="update-line">Installing {status.version}…</p>
              <div className="update-progress" role="progressbar" aria-valuenow={percent ?? undefined}>
                <i className={percent === null ? "is-indeterminate" : ""} style={percent === null ? undefined : { width: `${percent}%` }} />
              </div>
              <p className="update-note">
                {percent === null ? "Downloading…" : `${percent}% — Duckweed restarts when this finishes.`}
              </p>
            </>
          )}

          {status.kind === "failed" && (
            <>
              <p className="update-line">Could not check for updates.</p>
              <pre className="update-notes">{status.message}</pre>
            </>
          )}

          {status.kind === "idle" && <p className="update-line">Ready to check for updates.</p>}
        </div>

        <footer className="update-foot">
          {status.kind === "available" && (
            <button type="button" className="update-btn is-primary" onClick={install}>
              Install {status.update.version}
            </button>
          )}
          <button type="button" className="update-btn" onClick={close}>
            {status.kind === "installing" ? "Hide" : "Close"}
          </button>
        </footer>
      </div>
    </div>
  );
}
