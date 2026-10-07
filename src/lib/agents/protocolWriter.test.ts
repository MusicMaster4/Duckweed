import { describe, expect, test } from "bun:test";
import { ProtocolWriter } from "./protocolWriter";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const rpc = (id: number) => ({ id, method: "turn/start", params: { input: `message-${id}` } });

describe("ordered protocol writer", () => {
  test("keeps FIFO order while the first native write is pending", async () => {
    const blocked = deferred();
    const writes: unknown[] = [];
    const writer = new ProtocolWriter(async (message) => {
      writes.push(message);
      if (writes.length === 1) await blocked.promise;
    }, () => { throw new Error("unexpected failure"); });
    const first = writer.send(rpc(1));
    const second = writer.send(rpc(2));
    const third = writer.send(rpc(3));
    expect(writes).toEqual([rpc(1)]);
    blocked.resolve();
    await Promise.all([first, second, third]);
    expect(writes).toEqual([rpc(1), rpc(2), rpc(3)]);
    writer.close();
  });

  test("cancels an unsent request so a late write cannot deliver it", async () => {
    const blocked = deferred();
    const writes: unknown[] = [];
    const writer = new ProtocolWriter(async (message) => {
      writes.push(message);
      if (writes.length === 1) await blocked.promise;
    }, () => {});
    const first = writer.send(rpc(1));
    const second = writer.send(rpc(2));
    const third = writer.send(rpc(3));
    expect(writer.cancel(1)).toBe(false);
    expect(writer.cancel(2)).toBe(true);
    await expect(second).rejects.toMatchObject({ code: "duckweed_send_cancelled" });
    blocked.resolve();
    await Promise.all([first, third]);
    expect(writes).toEqual([rpc(1), rpc(3)]);
    writer.close();
  });

  test("a deadline rejects the blocked write and discards all later messages", async () => {
    const blocked = deferred();
    const writes: unknown[] = [];
    const failures: unknown[] = [];
    const writer = new ProtocolWriter(async (message) => {
      writes.push(message);
      await blocked.promise;
    }, (error) => failures.push(error), 20);
    const first = writer.send(rpc(1));
    const second = writer.send(rpc(2));
    await expect(first).rejects.toMatchObject({ code: "duckweed_send_timeout" });
    await expect(second).rejects.toMatchObject({ code: "duckweed_send_timeout" });
    blocked.resolve();
    await Promise.resolve();
    await expect(writer.send(rpc(3))).rejects.toMatchObject({ code: "duckweed_send_timeout" });
    expect(writes).toEqual([rpc(1)]);
    expect(failures).toHaveLength(1);
  });

  test("a failed write rejects the backlog without trying to send it", async () => {
    const blocked = deferred();
    const writes: unknown[] = [];
    const failures: unknown[] = [];
    const writer = new ProtocolWriter((message) => {
      writes.push(message);
      return blocked.promise;
    }, (error) => failures.push(error));
    const first = writer.send(rpc(1));
    const second = writer.send(rpc(2));
    blocked.reject(new Error("The pipe is closed."));
    await expect(first).rejects.toMatchObject({ code: "duckweed_send_failed", message: expect.stringContaining("The pipe is closed.") });
    await expect(second).rejects.toMatchObject({ code: "duckweed_send_failed" });
    expect(writes).toEqual([rpc(1)]);
    expect(failures).toHaveLength(1);
  });

  test("provider replies can release a write whose IPC callback was lost", async () => {
    const blocked = deferred();
    const writes: unknown[] = [];
    const failures: unknown[] = [];
    const writer = new ProtocolWriter(async (message) => {
      writes.push(message);
      if (writes.length === 1) await blocked.promise;
    }, (error) => failures.push(error), 20);
    const first = writer.send(rpc(1));
    const second = writer.send(rpc(2));
    writer.acknowledge(2);
    expect(writes).toEqual([rpc(1)]);
    writer.acknowledge(1);
    await Promise.all([first, second]);
    blocked.reject(new Error("A late IPC error"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(writes).toEqual([rpc(1), rpc(2)]);
    expect(failures).toEqual([]);
    writer.close();
  });

  test("closing rejects retained work and ignores a late native completion", async () => {
    const blocked = deferred();
    const writes: unknown[] = [];
    const writer = new ProtocolWriter((message) => {
      writes.push(message);
      return blocked.promise;
    }, () => { throw new Error("normal closure is not a transport failure"); });
    const first = writer.send(rpc(1));
    const second = writer.send(rpc(2));
    writer.close();
    await expect(first).rejects.toMatchObject({ code: "duckweed_closed" });
    await expect(second).rejects.toMatchObject({ code: "duckweed_closed" });
    blocked.resolve();
    await Promise.resolve();
    expect(writes).toEqual([rpc(1)]);
  });
});
