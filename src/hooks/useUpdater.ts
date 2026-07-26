import { useCallback, useEffect, useRef, useState } from "react";

import { appVersion, checkForUpdate, type AvailableUpdate } from "../lib/update";
import { channelOf, type Channel } from "../lib/version";

const TAURI_RUNTIME = "__TAURI_INTERNALS__" in window;

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; update: AvailableUpdate }
  | { kind: "installing"; version: string; fraction: number | null }
  | { kind: "failed"; message: string };

export interface Updater {
  version: string;
  channel: Channel;
  status: UpdateStatus;
  dialogOpen: boolean;
  /** User-initiated check — opens the dialog and reports whatever happens. */
  check: () => void;
  install: () => void;
  close: () => void;
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" && error ? error : "Update check failed.";
}

/**
 * Drives the "check for updates" flow. One quiet check runs a few seconds after
 * launch — it never opens anything, it just lights up the version chip when
 * there is something to install.
 */
export function useUpdater(): Updater {
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const [dialogOpen, setDialogOpen] = useState(false);

  const statusRef = useRef(status);
  statusRef.current = status;
  const busy = useRef(false);

  useEffect(() => {
    if (!TAURI_RUNTIME) return;
    let cancelled = false;
    void appVersion().then((v) => {
      if (!cancelled) setVersion(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(async (quiet: boolean) => {
    if (!TAURI_RUNTIME) return;
    if (busy.current) return;
    busy.current = true;
    if (!quiet) setStatus({ kind: "checking" });
    try {
      const update = await checkForUpdate();
      setStatus(update ? { kind: "available", update } : { kind: "current" });
    } catch (error) {
      // A quiet check that fails — offline, nothing released yet, running from
      // `tauri dev` — is not worth telling anyone about.
      setStatus(quiet ? { kind: "idle" } : { kind: "failed", message: message(error) });
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!TAURI_RUNTIME) return;
    const id = window.setTimeout(() => void run(true), 4000);
    return () => window.clearTimeout(id);
  }, [run]);

  const check = useCallback(() => {
    setDialogOpen(true);
    // An update the quiet check already found is still the answer.
    const current = statusRef.current;
    if (current.kind === "available" || current.kind === "installing") return;
    void run(false);
  }, [run]);

  const install = useCallback(() => {
    const current = statusRef.current;
    if (current.kind !== "available") return;
    const { update } = current;
    setStatus({ kind: "installing", version: update.version, fraction: null });
    void update
      .install((fraction) =>
        setStatus((prev) => (prev.kind === "installing" ? { ...prev, fraction } : prev)),
      )
      .catch((error) => setStatus({ kind: "failed", message: message(error) }));
  }, []);

  const close = useCallback(() => setDialogOpen(false), []);

  return { version, channel: channelOf(version), status, dialogOpen, check, install, close };
}
