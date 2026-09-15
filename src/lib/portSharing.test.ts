import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../../src-tauri/src/port_sharing.js", import.meta.url), "utf8")
  .replace("__DUCKWEED_PRIMARY_PORT__", "3000");

function browser() {
  const calls: unknown[][] = [];
  class Connection {
    static OPEN = 1;
    constructor(...args: unknown[]) { calls.push(args); }
  }
  class Xhr {
    open(...args: unknown[]) { calls.push(args); }
  }
  const context = {
    URL, Request,
    location: new URL("https://shared.example/dashboard"),
    fetch: (...args: unknown[]) => { calls.push(args); return Promise.resolve("response"); },
    XMLHttpRequest: Xhr, WebSocket: Connection, EventSource: Connection,
    navigator: { sendBeacon: (...args: unknown[]) => { calls.push(args); return true; } },
  };
  runInNewContext(script, context);
  return { context, calls };
}

describe("shared app browser routing", () => {
  test("routes backend fetches through HTTPS and retains uploads", async () => {
    const { context, calls } = browser();
    const init = { method: "POST", body: "payload", credentials: "include" };
    await context.fetch("http://localhost:8000/api?q=one", init);
    expect(calls[0]).toEqual(["https://shared.example/.duckweed/port/8000/api?q=one", init]);
    const request = new Request("http://127.0.0.1:8000/upload", { method: "POST", body: "file", headers: { "X-Test": "ok" } });
    await context.fetch(request);
    const forwarded = calls[1][0] as Request;
    expect(forwarded.url).toBe("https://shared.example/.duckweed/port/8000/upload");
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("x-test")).toBe("ok");
    expect(await forwarded.text()).toBe("file");
  });

  test("keeps frontend, relative and external URLs on their intended routes", async () => {
    const { context, calls } = browser();
    await context.fetch("http://localhost:3000/api");
    await context.fetch("/api");
    await context.fetch("https://external.example/api");
    expect(calls.map(call => call[0])).toEqual(["https://shared.example/api", "/api", "https://external.example/api"]);
  });

  test("supports XHR, WebSockets, IPv6, SSE and beacons without losing options", () => {
    const { context, calls } = browser();
    new context.XMLHttpRequest().open("POST", "http://[::1]:8000/api", true);
    new context.WebSocket("ws://localhost:8000/socket", ["chat"]);
    new context.WebSocket("ws://shared.example:3000/hmr");
    new context.EventSource("http://localhost:8000/events", { withCredentials: true });
    context.navigator.sendBeacon("http://localhost:8000/metrics", "data");
    expect(calls).toEqual([
      ["POST", "https://shared.example/.duckweed/port/8000/api", true],
      ["wss://shared.example/.duckweed/port/8000/socket", ["chat"]],
      ["wss://shared.example/hmr"],
      ["https://shared.example/.duckweed/port/8000/events", { withCredentials: true }],
      ["https://shared.example/.duckweed/port/8000/metrics", "data"],
    ]);
    expect(context.WebSocket.OPEN).toBe(1);
  });
});
