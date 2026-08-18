const PAIRING_MAX_MS = 10 * 60 * 1000;
const MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REQUEST_BYTES = 350_000;
const MAX_CIPHERTEXT = 320_000;
const MAX_PREVIEW_CIPHERTEXT = 3_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

export interface Env {
  DB: D1Database;
  FCM_SERVICE_ACCOUNT_JSON: string;
}

type Json = Record<string, unknown>;
type PushSender = (
  env: Env,
  token: string,
  data: Record<string, string>,
  collapseKey?: string | null,
) => Promise<void>;

interface PairingRow {
  pair_id: string;
  registration_token_hash: string;
  send_token_hash: string;
  expires_at: number | null;
  device_id: string | null;
  device_name: string | null;
  device_proof: string | null;
  fcm_token: string | null;
  receive_token_hash: string | null;
  paired_at: number | null;
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: string;
}

let cachedAccessToken: { clientEmail: string; token: string; expiresAt: number } | null = null;

function body(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function text(value: unknown, max = 512): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let offset = 0; offset < view.length; offset += 0x8000) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string): Promise<string> {
  return base64Url(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function sameHash(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return difference === 0;
}

async function matchesToken(expectedHash: string, token: string): Promise<boolean> {
  return sameHash(expectedHash, await sha256(token));
}

function bearer(request: Request): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

function response(data: Json, status: number): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function empty(status = 204): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function fail(status: number, error: string): Response {
  return response({ error }, status);
}

async function readBody(request: Request): Promise<Json | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return null;
  const raw = await request.text();
  if (encoder.encode(raw).byteLength > MAX_REQUEST_BYTES) return null;
  try {
    return body(JSON.parse(raw));
  } catch {
    return null;
  }
}

function pathParts(pathname: string): string[] {
  const parts = pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  return parts[0] === "api" ? parts.slice(1) : parts;
}

function envelope(value: unknown, max: number): { nonce: string; ciphertext: string } | null {
  const object = body(value);
  const nonce = text(object.nonce, 32);
  const ciphertext = text(object.ciphertext, max);
  if (!nonce || !ciphertext || !/^[A-Za-z0-9_-]{16}$/.test(nonce) || !BASE64URL_PATTERN.test(ciphertext)) return null;
  return { nonce, ciphertext };
}

async function pairing(env: Env, pairId: string): Promise<PairingRow | null> {
  return env.DB.prepare(`
    SELECT pair_id, registration_token_hash, send_token_hash, expires_at,
           device_id, device_name, device_proof, fcm_token,
           receive_token_hash, paired_at
      FROM pairings
     WHERE pair_id = ?
  `).bind(pairId).first<PairingRow>();
}

async function requireSend(env: Env, pairId: string, request: Request): Promise<PairingRow | null> {
  const token = bearer(request);
  if (!token) return null;
  const found = await pairing(env, pairId);
  return found && await matchesToken(found.send_token_hash, token) ? found : null;
}

async function requireReceive(env: Env, pairId: string, request: Request): Promise<PairingRow | null> {
  const token = bearer(request);
  if (!token) return null;
  const found = await pairing(env, pairId);
  return found?.receive_token_hash && await matchesToken(found.receive_token_hash, token) ? found : null;
}

async function pairingRateAllowed(env: Env, request: Request): Promise<boolean> {
  const source = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0].trim()
    ?? "unknown";
  const key = (await sha256(source)).slice(0, 20);
  const windowStart = Math.floor(Date.now() / 60_000);
  const row = await env.DB.prepare(`
    INSERT INTO pairing_rate_limits (source_hash, window_start, attempts)
    VALUES (?, ?, 1)
    ON CONFLICT(source_hash, window_start)
    DO UPDATE SET attempts = attempts + 1
    RETURNING attempts
  `).bind(key, windowStart).first<{ attempts: number }>();
  return (row?.attempts ?? 13) <= 12;
}

function parseServiceAccount(raw: string): ServiceAccount {
  const value = body(JSON.parse(raw));
  const projectId = text(value.project_id, 256);
  const clientEmail = text(value.client_email, 512);
  const privateKey = text(value.private_key, 10_000);
  const tokenUri = text(value.token_uri, 1_024) ?? "https://oauth2.googleapis.com/token";
  if (!projectId || !clientEmail || !privateKey || !tokenUri.startsWith("https://")) {
    throw new Error("FCM service account secret is incomplete");
  }
  return { project_id: projectId, client_email: clientEmail, private_key: privateKey, token_uri: tokenUri };
}

function pemBytes(pem: string): ArrayBuffer {
  const encoded = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function accessToken(env: Env): Promise<{ projectId: string; token: string }> {
  const account = parseServiceAccount(env.FCM_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1_000);
  if (cachedAccessToken?.clientEmail === account.client_email && cachedAccessToken.expiresAt > now + 300) {
    return { projectId: account.project_id, token: cachedAccessToken.token };
  }

  const header = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64Url(encoder.encode(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: account.token_uri,
    iat: now,
    exp: now + 3_600,
  })));
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned));
  const assertion = `${unsigned}.${base64Url(signature)}`;
  const tokenResponse = await fetch(account.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!tokenResponse.ok) throw new Error(`Google OAuth rejected the relay (${tokenResponse.status})`);
  const tokenBody = body(await tokenResponse.json());
  const token = text(tokenBody.access_token, 4_096);
  const expiresIn = typeof tokenBody.expires_in === "number" ? tokenBody.expires_in : 3_600;
  if (!token) throw new Error("Google OAuth returned no access token");
  cachedAccessToken = { clientEmail: account.client_email, token, expiresAt: now + expiresIn };
  return { projectId: account.project_id, token };
}

async function sendFcm(
  env: Env,
  token: string,
  data: Record<string, string>,
  collapseKey?: string | null,
): Promise<void> {
  const auth = await accessToken(env);
  const result = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(auth.projectId)}/messages:send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        token,
        data,
        android: {
          priority: "high",
          ttl: "604800s",
          ...(collapseKey ? { collapse_key: collapseKey } : {}),
        },
      },
    }),
  });
  if (!result.ok) throw new Error(`FCM rejected the encrypted notification (${result.status})`);
}

export async function handleRequest(request: Request, env: Env, push: PushSender = sendFcm): Promise<Response> {
  const parts = pathParts(new URL(request.url).pathname);
  try {
    if (request.method === "GET" && parts.length === 1 && parts[0] === "health") {
      return response({ ok: true, version: 1, storage: "d1" }, 200);
    }

    if (request.method === "POST" && parts.join("/") === "v1/pairings") {
      if (!await pairingRateAllowed(env, request)) return fail(429, "too many pairing attempts");
      const input = await readBody(request);
      if (!input) return fail(400, "invalid pairing request");
      const pairId = text(input.pairId, 64);
      const registrationTokenHash = text(input.registrationTokenHash, 64);
      const sendTokenHash = text(input.sendTokenHash, 64);
      const expiresAt = typeof input.expiresAt === "number" ? input.expiresAt : 0;
      const now = Date.now();
      if (
        !pairId || !UUID_PATTERN.test(pairId)
        || !registrationTokenHash || !TOKEN_PATTERN.test(registrationTokenHash)
        || !sendTokenHash || !TOKEN_PATTERN.test(sendTokenHash)
        || expiresAt <= now || expiresAt > now + PAIRING_MAX_MS + 30_000
      ) return fail(400, "invalid pairing request");

      const existing = await pairing(env, pairId);
      if (existing) return fail(409, "pairing already exists");
      await env.DB.prepare(`
        INSERT INTO pairings (
          pair_id, registration_token_hash, send_token_hash, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?)
      `).bind(pairId, registrationTokenHash, sendTokenHash, now, expiresAt).run();
      return response({ ok: true }, 201);
    }

    const pairId = parts[2];
    if (parts[0] !== "v1" || parts[1] !== "pairings" || !pairId || !UUID_PATTERN.test(pairId)) {
      return fail(404, "not found");
    }

    if (request.method === "POST" && parts.length === 4 && parts[3] === "register") {
      const found = await pairing(env, pairId);
      const input = await readBody(request);
      if (!input) return fail(400, "invalid pairing credential");
      const registrationToken = text(input.registrationToken, 256);
      const receiveToken = text(input.receiveToken, 256);
      const fcmToken = text(input.fcmToken, 4_096);
      const deviceId = text(input.deviceId, 128);
      const name = text(input.name, 80);
      const proof = text(input.proof, 128);
      if (!found || (found.expires_at ?? 0) <= Date.now()) return fail(410, "pairing expired");
      if (found.device_id) return fail(409, "phone already paired");
      if (
        !registrationToken || !receiveToken
        || !TOKEN_PATTERN.test(registrationToken) || !TOKEN_PATTERN.test(receiveToken)
        || !await matchesToken(found.registration_token_hash, registrationToken)
        || !fcmToken || !deviceId || !name || !proof || !TOKEN_PATTERN.test(proof)
      ) return fail(401, "invalid pairing credential");

      const pairedAt = Date.now();
      const updated = await env.DB.prepare(`
        UPDATE pairings
           SET device_id = ?, device_name = ?, device_proof = ?, fcm_token = ?,
               receive_token_hash = ?, paired_at = ?, expires_at = NULL
         WHERE pair_id = ? AND device_id IS NULL AND registration_token_hash = ?
      `).bind(
        deviceId,
        name,
        proof,
        fcmToken,
        await sha256(receiveToken),
        pairedAt,
        pairId,
        found.registration_token_hash,
      ).run();
      if (updated.meta.changes !== 1) return fail(409, "phone already paired");
      return response({ pairedAt }, 200);
    }

    if (request.method === "GET" && parts.length === 3) {
      const found = await pairing(env, pairId);
      if (!found) return fail(404, "pairing not found");
      const token = bearer(request);
      if (!token || !await matchesToken(found.send_token_hash, token)) {
        return fail(401, "invalid sender credential");
      }
      return response({
        device: found.device_id ? {
          id: found.device_id,
          name: found.device_name,
          proof: found.device_proof,
          pairedAt: found.paired_at,
        } : null,
      }, 200);
    }

    if (request.method === "DELETE" && parts.length === 3) {
      const found = await requireSend(env, pairId, request);
      if (!found) return fail(401, "invalid sender credential");
      await env.DB.batch([
        env.DB.prepare("DELETE FROM messages WHERE pair_id = ?").bind(pairId),
        env.DB.prepare("DELETE FROM commands WHERE pair_id = ?").bind(pairId),
        env.DB.prepare("DELETE FROM pairings WHERE pair_id = ?").bind(pairId),
      ]);
      return empty();
    }

    if (parts.length === 4 && parts[3] === "device") {
      const found = await requireReceive(env, pairId, request);
      if (!found) return fail(401, "invalid receiver credential");
      if (request.method === "PUT") {
        const input = await readBody(request);
        const fcmToken = input && text(input.fcmToken, 4_096);
        if (!fcmToken) return fail(400, "invalid push registration");
        await env.DB.prepare(
          "UPDATE pairings SET fcm_token = ?, token_updated_at = ? WHERE pair_id = ?",
        ).bind(fcmToken, Date.now(), pairId).run();
        return empty();
      }
      if (request.method === "DELETE") {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM messages WHERE pair_id = ?").bind(pairId),
          env.DB.prepare("DELETE FROM commands WHERE pair_id = ?").bind(pairId),
          env.DB.prepare("DELETE FROM pairings WHERE pair_id = ?").bind(pairId),
        ]);
        return empty();
      }
    }

    if (request.method === "POST" && parts.length === 4 && parts[3] === "messages") {
      const found = await requireSend(env, pairId, request);
      if (!found?.device_id || !found.fcm_token) {
        return fail(found ? 409 : 401, found ? "phone has not paired" : "invalid sender credential");
      }
      const input = await readBody(request);
      if (!input) return fail(400, "invalid encrypted message");
      const messageId = text(input.messageId, 64);
      const sentAt = typeof input.sentAt === "number" ? input.sentAt : 0;
      const collapseKey = text(input.collapseKey, 128);
      const preview = envelope(input.preview, MAX_PREVIEW_CIPHERTEXT);
      const payload = envelope(input.payload, MAX_CIPHERTEXT);
      if (!messageId || !UUID_PATTERN.test(messageId) || !preview || !payload || Math.abs(Date.now() - sentAt) > 10 * 60 * 1000) {
        return fail(400, "invalid encrypted message");
      }

      const now = Date.now();
      await env.DB.prepare(`
        INSERT OR REPLACE INTO messages (
          pair_id, message_id, payload_nonce, payload_ciphertext,
          sent_at, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        pairId,
        messageId,
        payload.nonce,
        payload.ciphertext,
        sentAt,
        now,
        now + MESSAGE_TTL_MS,
      ).run();
      try {
        await push(env, found.fcm_token, {
          version: "1",
          pair_id: pairId,
          message_id: messageId,
          preview_nonce: preview.nonce,
          preview_ciphertext: preview.ciphertext,
        }, collapseKey);
      } catch (error) {
        await env.DB.prepare("DELETE FROM messages WHERE pair_id = ? AND message_id = ?")
          .bind(pairId, messageId).run();
        console.error("FCM delivery rejected", { pairId, messageId, error: String(error) });
        return fail(502, "push provider rejected the message");
      }
      return response({ accepted: true, messageId }, 202);
    }

    if (parts.length === 4 && parts[3] === "commands") {
      if (request.method === "POST") {
        const found = await requireReceive(env, pairId, request);
        if (!found?.device_id) return fail(found ? 409 : 401, found ? "phone has not paired" : "invalid receiver credential");
        const input = await readBody(request);
        if (!input) return fail(400, "invalid encrypted command");
        const commandId = text(input.commandId, 64);
        const sentAt = typeof input.sentAt === "number" ? input.sentAt : 0;
        const payload = envelope(input.payload, MAX_CIPHERTEXT);
        if (!commandId || !UUID_PATTERN.test(commandId) || !payload || Math.abs(Date.now() - sentAt) > 10 * 60 * 1000) {
          return fail(400, "invalid encrypted command");
        }
        const now = Date.now();
        await env.DB.prepare(`
          INSERT OR IGNORE INTO commands (
            pair_id, command_id, payload_nonce, payload_ciphertext,
            sent_at, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          pairId,
          commandId,
          payload.nonce,
          payload.ciphertext,
          sentAt,
          now,
          now + MESSAGE_TTL_MS,
        ).run();
        return response({ accepted: true, commandId }, 202);
      }

      if (request.method === "GET") {
        const found = await pairing(env, pairId);
        if (!found) return fail(404, "pairing not found");
        const token = bearer(request);
        if (!token || !await matchesToken(found.send_token_hash, token)) {
          return fail(401, "invalid sender credential");
        }
        const commands = await env.DB.prepare(`
          SELECT command_id, payload_nonce, payload_ciphertext, sent_at
            FROM commands
           WHERE pair_id = ? AND expires_at > ?
           ORDER BY created_at ASC
           LIMIT 50
        `).bind(pairId, Date.now()).all<{
          command_id: string;
          payload_nonce: string;
          payload_ciphertext: string;
          sent_at: number;
        }>();
        return response({
          commands: commands.results.map((command) => ({
            commandId: command.command_id,
            payload: { nonce: command.payload_nonce, ciphertext: command.payload_ciphertext },
            sentAt: command.sent_at,
          })),
        }, 200);
      }
    }

    const commandId = parts[4];
    if (parts.length === 5 && parts[3] === "commands" && commandId && UUID_PATTERN.test(commandId)) {
      if (request.method === "GET") {
        const found = await requireReceive(env, pairId, request);
        if (!found) return fail(401, "invalid receiver credential");
        const pending = await env.DB.prepare(
          "SELECT 1 AS present FROM commands WHERE pair_id = ? AND command_id = ? AND expires_at > ?",
        ).bind(pairId, commandId, Date.now()).first<{ present: number }>();
        return response({ pending: Boolean(pending?.present) }, 200);
      }
      const found = await requireSend(env, pairId, request);
      if (!found) return fail(401, "invalid sender credential");
      if (request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM commands WHERE pair_id = ? AND command_id = ?")
          .bind(pairId, commandId).run();
        return empty();
      }
    }

    const messageId = parts[4];
    if (parts.length === 5 && parts[3] === "messages" && messageId && UUID_PATTERN.test(messageId)) {
      const found = await requireReceive(env, pairId, request);
      if (!found) return fail(401, "invalid receiver credential");
      if (request.method === "GET") {
        const message = await env.DB.prepare(`
          SELECT payload_nonce, payload_ciphertext, sent_at
            FROM messages
           WHERE pair_id = ? AND message_id = ? AND expires_at > ?
        `).bind(pairId, messageId, Date.now()).first<{
          payload_nonce: string;
          payload_ciphertext: string;
          sent_at: number;
        }>();
        if (!message) return fail(404, "message not found");
        return response({
          payload: { nonce: message.payload_nonce, ciphertext: message.payload_ciphertext },
          sentAt: message.sent_at,
        }, 200);
      }
      if (request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM messages WHERE pair_id = ? AND message_id = ?")
          .bind(pairId, messageId).run();
        return empty();
      }
    }

    return fail(404, "not found");
  } catch (error) {
    console.error("notification relay request failed", { path: new URL(request.url).pathname, error: String(error) });
    return fail(500, "relay request failed");
  }
}

async function cleanup(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM commands WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM pairings WHERE device_id IS NULL AND expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM pairing_rate_limits WHERE window_start < ?").bind(Math.floor(now / 60_000) - 2 * 24 * 60),
  ]);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
  scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): void {
    context.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
