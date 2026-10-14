import { listen } from "@tauri-apps/api/event";
import { mobileSendPromptTemplates, mobileStatus } from "./ipc";
import { getPromptTemplates, subscribe } from "./promptTemplates";

interface PromptSyncDependencies {
  send: typeof mobileSendPromptTemplates;
  status: typeof mobileStatus;
  getTemplates: typeof getPromptTemplates;
  subscribe: typeof subscribe;
  onTick: (callback: () => void) => Promise<() => void>;
  onDevices: (callback: (paired: boolean) => void) => Promise<() => void>;
  runtime: Pick<Window, "setTimeout" | "clearTimeout" | "addEventListener" | "removeEventListener">;
}

/** Publish independently from live terminal traffic, preserving full prompt text. */
export function startMobilePromptSync(deps: PromptSyncDependencies = {
  send: mobileSendPromptTemplates,
  status: mobileStatus,
  getTemplates: getPromptTemplates,
  subscribe,
  onTick: callback => listen("mobile:sync-tick", callback),
  onDevices: callback => listen<boolean>("mobile:devices-changed", ({ payload }) => callback(payload)),
  runtime: window,
}): () => void {
  const runtime = deps.runtime;
  let stopped = false;
  let paired = false;
  let sending = false;
  let queued = false;
  let force = false;
  let lastSent = "";
  let timer = 0;
  const schedule = (delay = 250) => {
    if (stopped || !paired) return;
    queued = true;
    if (!sending && !timer) timer = runtime.setTimeout(() => { timer = 0; void publish(); }, delay);
  };
  const publish = async () => {
    if (stopped || !paired || sending) return;
    const templates = deps.getTemplates();
    const serialized = JSON.stringify(templates);
    queued = false;
    if (!force && serialized === lastSent) return;
    force = false;
    sending = true;
    let retry = false;
    try {
      const result = await deps.send(templates);
      if (result.failed) throw new Error(result.errors.join("; "));
      lastSent = serialized;
    } catch (error) {
      console.error("mobile prompt sync", error);
      retry = true;
      force = true;
    } finally {
      sending = false;
      if (retry || queued) schedule(retry ? 5_000 : 250);
    }
  };
  const refresh = () => { if (stopped) return; paired = true; force = true; schedule(); };
  const offTemplates = deps.subscribe(() => schedule());
  runtime.addEventListener("duckweed:mobile-paired", refresh);
  runtime.addEventListener("duckweed:mobile-refresh", refresh);
  const tick = deps.onTick(() => {
    if (!paired) refresh();
    if (queued && !sending) {
      if (timer) runtime.clearTimeout(timer);
      timer = 0;
      void publish();
    }
  });
  const devices = deps.onDevices(payload => {
    if (payload) refresh();
    else { paired = false; lastSent = ""; }
  });
  void deps.status().then(status => {
    if (!stopped && status.devices.length) refresh();
  }).catch(error => console.error("mobile prompt pairing status", error));
  return () => {
    stopped = true;
    if (timer) runtime.clearTimeout(timer);
    offTemplates();
    runtime.removeEventListener("duckweed:mobile-paired", refresh);
    runtime.removeEventListener("duckweed:mobile-refresh", refresh);
    void tick.then(off => off());
    void devices.then(off => off());
  };
}
