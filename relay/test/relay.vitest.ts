import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import worker, { androidPushConfig, handleRequest, type Env } from "../src/index";

const encoder = new TextEncoder();

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hash(value: string): Promise<string> {
  return base64Url(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function request(path: string, method = "GET", token?: string, value?: unknown, ip = "203.0.113.5"): Request {
  const headers = new Headers({ "cf-connecting-ip": ip });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (value !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://relay.example${path}`, {
    method,
    headers,
    body: value === undefined ? undefined : JSON.stringify(value),
  });
}

describe("encrypted notification relay", () => {
  it("reserves high priority for alerts and sends silent syncs at normal priority", () => {
    const data = { pair_id: "desktop-1", message_id: "completion-1" };
    expect(androidPushConfig(data)).toEqual({ priority: "high", ttl: "604800s" });
    expect(androidPushConfig(data, "workspace:desktop-1")).toEqual({
      priority: "normal", ttl: "604800s", collapse_key: "workspace:desktop-1",
    });
    expect(androidPushConfig({ ...data, message_id: data.pair_id }, data.pair_id)).toEqual({
      priority: "normal", ttl: "604800s", collapse_key: data.pair_id,
    });
    expect(androidPushConfig(data, "completion-1").priority).toBe("high");
    expect(androidPushConfig(data, "workspace:other-desktop").priority).toBe("high");
    expect(androidPushConfig(data, data.pair_id).priority).toBe("high");
  });

  it("pairs, pushes only encrypted data, retrieves the payload, and acknowledges it", async () => {
    const pairId = "10000000-0000-4000-8000-000000000001";
    const messageId = "20000000-0000-4000-8000-000000000002";
    const registrationToken = "r".repeat(43);
    const sendToken = "s".repeat(43);
    const receiveToken = "v".repeat(43);
    const pushed: Array<{ token: string; data: Record<string, string> }> = [];
    const push = async (_env: Env, token: string, data: Record<string, string>) => {
      pushed.push({ token, data });
    };

    const created = await handleRequest(request("/v1/pairings", "POST", undefined, {
      pairId,
      registrationTokenHash: await hash(registrationToken),
      sendTokenHash: await hash(sendToken),
      expiresAt: Date.now() + 9 * 60_000,
    }), env, push);
    expect(created.status).toBe(201);

    const registered = await handleRequest(request(`/v1/pairings/${pairId}/register`, "POST", undefined, {
      registrationToken,
      receiveToken,
      fcmToken: "fcm-device-token",
      deviceId: "phone-1",
      name: "Pixel",
      proof: "p".repeat(43),
    }), env, push);
    expect(registered.status).toBe(200);

    const status = await handleRequest(request(`/v1/pairings/${pairId}`, "GET", sendToken), env, push);
    expect(await status.json()).toMatchObject({
      device: { id: "phone-1", name: "Pixel", proof: "p".repeat(43) },
    });

    const preview = { nonce: "A".repeat(16), ciphertext: "B".repeat(96) };
    const payload = { nonce: "C".repeat(16), ciphertext: "D".repeat(10_000) };
    const sent = await handleRequest(request(`/v1/pairings/${pairId}/messages`, "POST", sendToken, {
      messageId,
      sentAt: Date.now(),
      preview,
      payload,
    }), env, push);
    expect(sent.status).toBe(202);
    expect(pushed).toEqual([{
      token: "fcm-device-token",
      data: {
        version: "1",
        pair_id: pairId,
        message_id: messageId,
        preview_nonce: preview.nonce,
        preview_ciphertext: preview.ciphertext,
      },
    }]);
    expect(JSON.stringify(pushed)).not.toContain(payload.ciphertext);

    // FCM is a wake-up hint, not the only recovery path. A phone that missed
    // the push can list opaque pending ids when it returns to the foreground.
    const pending = await handleRequest(
      request(`/v1/pairings/${pairId}/messages`, "GET", receiveToken),
      env,
      push,
    );
    expect(await pending.json()).toMatchObject({
      messages: [{ messageId }],
    });

    const unauthorizedPending = await handleRequest(
      request(`/v1/pairings/${pairId}/messages`, "GET", sendToken),
      env,
      push,
    );
    expect(unauthorizedPending.status).toBe(401);

    const fetched = await handleRequest(
      request(`/v1/pairings/${pairId}/messages/${messageId}`, "GET", receiveToken),
      env,
      push,
    );
    expect(await fetched.json()).toMatchObject({ payload });

    const acknowledged = await handleRequest(
      request(`/v1/pairings/${pairId}/messages/${messageId}`, "DELETE", receiveToken),
      env,
      push,
    );
    expect(acknowledged.status).toBe(204);

    const emptyPending = await handleRequest(
      request(`/v1/pairings/${pairId}/messages`, "GET", receiveToken),
      env,
      push,
    );
    expect(await emptyPending.json()).toEqual({ messages: [] });

    const gone = await handleRequest(
      request(`/v1/pairings/${pairId}/messages/${messageId}`, "GET", receiveToken),
      env,
      push,
    );
    expect(gone.status).toBe(404);
  });

  it("retains a stored payload if FCM rejects the push", async () => {
    const pairId = "30000000-0000-4000-8000-000000000003";
    const messageId = "40000000-0000-4000-8000-000000000004";
    const registrationToken = "a".repeat(43);
    const sendToken = "b".repeat(43);
    const receiveToken = "c".repeat(43);
    const accept = async () => {};

    await handleRequest(request("/v1/pairings", "POST", undefined, {
      pairId,
      registrationTokenHash: await hash(registrationToken),
      sendTokenHash: await hash(sendToken),
      expiresAt: Date.now() + 9 * 60_000,
    }, "203.0.113.6"), env, accept);
    await handleRequest(request(`/v1/pairings/${pairId}/register`, "POST", undefined, {
      registrationToken,
      receiveToken,
      fcmToken: "fcm-device-token",
      deviceId: "phone-2",
      name: "Phone",
      proof: "d".repeat(43),
    }), env, accept);

    const rejected = await handleRequest(request(`/v1/pairings/${pairId}/messages`, "POST", sendToken, {
      messageId,
      sentAt: Date.now(),
      preview: { nonce: "E".repeat(16), ciphertext: "F".repeat(64) },
      payload: { nonce: "G".repeat(16), ciphertext: "H".repeat(64) },
    }), env, async () => { throw new Error("rejected"); });
    expect(rejected.status).toBe(202);

    const fetched = await handleRequest(
      request(`/v1/pairings/${pairId}/messages/${messageId}`, "GET", receiveToken),
      env,
      accept,
    );
    expect(fetched.status).toBe(200);

    // Storage completes before a delayed notification provider responds.
    let finishPush!: () => void;
    const pushPending = new Promise<void>(resolve => { finishPush = resolve; });
    const background: Promise<unknown>[] = [];
    const stored = await handleRequest(request(`/v1/pairings/${pairId}/messages`, "POST", sendToken, {
      messageId: "40000000-0000-4000-8000-000000000005",
      sentAt: Date.now(),
      preview: { nonce: "E".repeat(16), ciphertext: "F".repeat(64) },
      payload: { nonce: "G".repeat(16), ciphertext: "H".repeat(64) },
      collapseKey: `workspace:${pairId}`,
    }), env, () => pushPending, { waitUntil: promise => { background.push(promise); } });
    expect(stored.status).toBe(202);
    expect(background).toHaveLength(1);
    finishPush();
    await Promise.all(background);
  });

  it("collapses workspace snapshots, serves inline ciphertext, and ignores stale replacement and ACKs", async () => {
    const pairId = "70000000-0000-4000-8000-000000000007";
    const sendToken = "m".repeat(43), receiveToken = "n".repeat(43), registrationToken = "o".repeat(43);
    const accept = async () => {};
    await handleRequest(request("/v1/pairings", "POST", undefined, {
      pairId, registrationTokenHash: await hash(registrationToken), sendTokenHash: await hash(sendToken), expiresAt: Date.now() + 60_000,
    }, "203.0.113.8"), env, accept);
    await handleRequest(request(`/v1/pairings/${pairId}/register`, "POST", undefined, {
      registrationToken, receiveToken, fcmToken: "token", deviceId: "phone", name: "Phone", proof: "p".repeat(43),
    }), env, accept);
    const at = Date.now();
    const preview = { nonce: "Q".repeat(16), ciphertext: "R".repeat(64) };
    const payload = { nonce: "S".repeat(16), ciphertext: "T".repeat(64) };
    const send = (id: string, sentAt: number, collapseKey?: string) => handleRequest(request(`/v1/pairings/${pairId}/messages`, "POST", sendToken,
      { messageId: id, sentAt, collapseKey, preview, payload }), env, accept);
    const first = "71000000-0000-4000-8000-000000000001";
    const latest = "71000000-0000-4000-8000-000000000002";
    const completion = "71000000-0000-4000-8000-000000000003";
    await send(first, at, `workspace:${pairId}`);
    await send(latest, at + 1, `workspace:${pairId}`);
    await send(first, at, `workspace:${pairId}`);
    await send(completion, at + 2);
    const pending = await handleRequest(request(`/v1/pairings/${pairId}/messages?inline=1`, "GET", receiveToken), env, accept);
    expect(await pending.json()).toMatchObject({ messages: [{ messageId: latest, payload }, { messageId: completion, payload }], hasMore: false });
    expect((await handleRequest(request(`/v1/pairings/${pairId}/messages/${first}`, "GET", receiveToken), env, accept)).status).toBe(404);
    // Heartbeats reuse their id; an ACK for the older revision must not erase the newer one.
    await send(pairId, at, pairId);
    await send(pairId, at + 3, pairId);
    await handleRequest(request(`/v1/pairings/${pairId}/messages/${pairId}?sentAt=${at}`, "DELETE", receiveToken), env, accept);
    expect((await handleRequest(request(`/v1/pairings/${pairId}/messages/${pairId}`, "GET", receiveToken), env, accept)).status).toBe(200);
    await handleRequest(request(`/v1/pairings/${pairId}/messages/${pairId}?sentAt=${at + 3}`, "DELETE", receiveToken), env, accept);
    expect((await handleRequest(request(`/v1/pairings/${pairId}/messages/${pairId}`, "GET", receiveToken), env, accept)).status).toBe(404);
    expect((await handleRequest(request(`/v1/pairings/${pairId}/messages?inline=1`, "GET", sendToken), env, accept)).status).toBe(401);
  });

  it("relays encrypted phone commands back to the paired desktop", async () => {
    const pairId = "50000000-0000-4000-8000-000000000005";
    const commandId = "60000000-0000-4000-8000-000000000006";
    const registrationToken = "e".repeat(43);
    const sendToken = "f".repeat(43);
    const receiveToken = "g".repeat(43);
    const accept = async () => {};

    await handleRequest(request("/v1/pairings", "POST", undefined, {
      pairId,
      registrationTokenHash: await hash(registrationToken),
      sendTokenHash: await hash(sendToken),
      expiresAt: Date.now() + 9 * 60_000,
    }, "203.0.113.7"), env, accept);
    await handleRequest(request(`/v1/pairings/${pairId}/register`, "POST", undefined, {
      registrationToken,
      receiveToken,
      fcmToken: "fcm-command-token",
      deviceId: "phone-3",
      name: "Phone",
      proof: "h".repeat(43),
    }), env, accept);

    const payload = { nonce: "I".repeat(16), ciphertext: "J".repeat(256) };
    const queued = await handleRequest(request(`/v1/pairings/${pairId}/commands`, "POST", receiveToken, {
      commandId,
      sentAt: Date.now(),
      payload,
    }), env, accept);
    expect(queued.status).toBe(202);
    const duplicate = await handleRequest(request(`/v1/pairings/${pairId}/commands`, "POST", receiveToken, {
      commandId,
      sentAt: Date.now(),
      payload,
    }), env, accept);
    expect(duplicate.status).toBe(202);

    const pending = await handleRequest(
      request(`/v1/pairings/${pairId}/commands/${commandId}`, "GET", receiveToken),
      env,
      accept,
    );
    expect(await pending.json()).toEqual({ pending: true });

    const polled = await handleRequest(
      request(`/v1/pairings/${pairId}/commands`, "GET", sendToken),
      env,
      accept,
    );
    expect(await polled.json()).toMatchObject({ commands: [{ commandId, payload }] });

    const unauthorized = await handleRequest(
      request(`/v1/pairings/${pairId}/commands`, "GET", receiveToken),
      env,
      accept,
    );
    expect(unauthorized.status).toBe(401);

    const acknowledged = await handleRequest(
      request(`/v1/pairings/${pairId}/commands/${commandId}`, "DELETE", sendToken),
      env,
      accept,
    );
    expect(acknowledged.status).toBe(204);
    const delivered = await handleRequest(
      request(`/v1/pairings/${pairId}/commands/${commandId}`, "GET", receiveToken),
      env,
      accept,
    );
    expect(await delivered.json()).toEqual({ pending: false });
    const emptyQueue = await handleRequest(
      request(`/v1/pairings/${pairId}/commands`, "GET", sendToken),
      env,
      accept,
    );
    expect(await emptyQueue.json()).toEqual({ commands: [] });
  });

  it("distinguishes a deleted pairing from a bad sender credential", async () => {
    const pairId = "70000000-0000-4000-8000-000000000007";
    const missingId = "80000000-0000-4000-8000-000000000008";
    const registrationToken = "i".repeat(43);
    const sendToken = "j".repeat(43);
    const accept = async () => {};

    await handleRequest(request("/v1/pairings", "POST", undefined, {
      pairId,
      registrationTokenHash: await hash(registrationToken),
      sendTokenHash: await hash(sendToken),
      expiresAt: Date.now() + 9 * 60_000,
    }, "203.0.113.8"), env, accept);

    const badStatus = await handleRequest(
      request(`/v1/pairings/${pairId}`, "GET", "k".repeat(43)),
      env,
      accept,
    );
    expect(badStatus.status).toBe(401);

    const missingStatus = await handleRequest(
      request(`/v1/pairings/${missingId}`, "GET", sendToken),
      env,
      accept,
    );
    expect(missingStatus.status).toBe(404);

    const missingCommands = await handleRequest(
      request(`/v1/pairings/${missingId}/commands`, "GET", sendToken),
      env,
      accept,
    );
    expect(missingCommands.status).toBe(404);
  });

  it("rate limits pairing creation by source address", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);
    try {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const invalid = await handleRequest(request("/v1/pairings", "POST", undefined, {}, "198.51.100.9"), env);
        expect(invalid.status).toBe(400);
      }
      const limited = await handleRequest(request("/v1/pairings", "POST", undefined, {}, "198.51.100.9"), env);
      expect(limited.status).toBe(429);
    } finally {
      now.mockRestore();
    }
  });

  it("reports the D1-backed health endpoint without touching FCM", async () => {
    const health = await worker.fetch(request("/health"), env);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, version: 1, storage: "d1" });
  });
});
