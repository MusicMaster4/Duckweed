import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker, { handleRequest, type Env } from "../src/index";

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

    const gone = await handleRequest(
      request(`/v1/pairings/${pairId}/messages/${messageId}`, "GET", receiveToken),
      env,
      push,
    );
    expect(gone.status).toBe(404);
  });

  it("removes a stored payload if FCM rejects the push", async () => {
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
    expect(rejected.status).toBe(502);

    const fetched = await handleRequest(
      request(`/v1/pairings/${pairId}/messages/${messageId}`, "GET", receiveToken),
      env,
      accept,
    );
    expect(fetched.status).toBe(404);
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
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const invalid = await handleRequest(request("/v1/pairings", "POST", undefined, {}, "198.51.100.9"), env);
      expect(invalid.status).toBe(400);
    }
    const limited = await handleRequest(request("/v1/pairings", "POST", undefined, {}, "198.51.100.9"), env);
    expect(limited.status).toBe(429);
  });

  it("reports the D1-backed health endpoint without touching FCM", async () => {
    const health = await worker.fetch(request("/health"), env);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, version: 1, storage: "d1" });
  });
});
