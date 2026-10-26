import { describe, expect, test } from "bun:test";
import { createRefreshQueue } from "./refreshQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("changes refresh queue", () => {
  test("shows a completed read during ongoing writes and coalesces the next read", async () => {
    const reads = [deferred<number>(), deferred<number>()];
    const values: number[] = [];
    let calls = 0;
    const queue = createRefreshQueue(() => reads[calls++].promise, (n) => values.push(n), () => {});
    queue.refresh();
    await flush();
    for (let i = 0; i < 100; i++) queue.refresh();
    expect(calls).toBe(1);
    reads[0].resolve(1);
    await flush();
    expect(values).toEqual([1]);
    expect(calls).toBe(2);
    reads[1].resolve(2);
    await flush();
    expect(values).toEqual([1, 2]);
    expect(calls).toBe(2);
    queue.stop();
  });

  test("ignores results from a closed panel or previous project", async () => {
    const read = deferred<number>();
    const values: number[] = [];
    const queue = createRefreshQueue(() => read.promise, (n) => values.push(n), () => {});
    queue.refresh();
    queue.refresh();
    await flush();
    queue.stop();
    read.resolve(1);
    await flush();
    expect(values).toEqual([]);
  });

  test("a discard invalidates an older snapshot while queuing a fresh read", async () => {
    const reads = [deferred<number>(), deferred<number>()];
    const values: number[] = [];
    let calls = 0;
    const queue = createRefreshQueue(() => reads[calls++].promise, (n) => values.push(n), () => {});
    queue.refresh();
    await flush();
    queue.invalidate();
    reads[0].resolve(1);
    await flush();
    expect(values).toEqual([]);
    expect(calls).toBe(2);
    reads[1].resolve(2);
    await flush();
    expect(values).toEqual([2]);
    queue.stop();
  });

  test("times out, allows retry, and ignores the late result", async () => {
    const reads = [deferred<number>(), deferred<number>()];
    const values: number[] = [];
    const errors: unknown[] = [];
    let calls = 0;
    const queue = createRefreshQueue(() => reads[calls++].promise, (n) => values.push(n), (e) => errors.push(e), 15);
    queue.refresh();
    queue.refresh();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("timed out");
    expect(calls).toBe(1);
    queue.refresh();
    await flush();
    reads[0].resolve(1);
    reads[1].resolve(2);
    await flush();
    expect(values).toEqual([2]);
    queue.stop();
  });

  test("recovers after a failed read without replaying a queued failure", async () => {
    const read = deferred<number>();
    const values: number[] = [];
    const errors: unknown[] = [];
    let calls = 0;
    const queue = createRefreshQueue(() => ++calls === 1 ? read.promise : Promise.resolve(2), (n) => values.push(n), (e) => errors.push(e));
    queue.refresh();
    queue.refresh();
    read.reject("failed");
    await flush();
    expect(errors).toEqual(["failed"]);
    expect(calls).toBe(1);
    queue.refresh();
    await flush();
    expect(values).toEqual([2]);
    queue.stop();
  });
});
