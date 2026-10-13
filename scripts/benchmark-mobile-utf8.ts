import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { truncateUtf8, truncateUtf8Tail, utf8ByteLength } from "../src/lib/mobileWorkspace";

// The audited revision is fixed so reruns still compare the same algorithms.
const revision = process.argv[2] ?? "5070dcbacebea673fae1f607afd9c0255df02981";
const original = execFileSync("git", ["show", `${revision}:src/lib/mobileWorkspace.ts`], { encoding: "utf8" });
const fragment = original.slice(original.indexOf("export function truncateUtf8("), original.indexOf("export interface MobileTerminalActivity"));
const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(fragment.replaceAll("export ", ""));
const before = new Function("utf8ByteLength", `${transpiled}; return { truncateUtf8, truncateUtf8Tail };`)(utf8ByteLength) as {
  truncateUtf8: typeof truncateUtf8;
  truncateUtf8Tail: typeof truncateUtf8Tail;
};

let seed = 123456789;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const alphabet = ["A", "\n", "\0", "\u00e9", "\u6f22", "e\u0301", "\ud83e\udd86", "\ud800", "\udc00"];
let comparisons = 0;
for (let sample = 0; sample < 300; sample += 1) {
  const value = Array.from({ length: random() % 70 }, () => alphabet[random() % alphabet.length]).join("");
  for (let budget = 0; budget <= utf8ByteLength(value) + 5; budget += 1) {
    assert.equal(truncateUtf8(value, budget), before.truncateUtf8(value, budget), `prefix sample ${sample}, budget ${budget}`);
    assert.equal(truncateUtf8Tail(value, budget), before.truncateUtf8Tail(value, budget), `tail sample ${sample}, budget ${budget}`);
    comparisons += 2;
  }
}

const value = "\u6f22\ud83e\udd86".repeat(20_000);
const budget = 16_000;
const iterations = 15;
const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
const time = (fn: typeof truncateUtf8) => {
  const start = performance.now();
  const result = fn(value, budget);
  assert(utf8ByteLength(result) <= budget);
  return performance.now() - start;
};
const measure = (old: typeof truncateUtf8, current: typeof truncateUtf8) => {
  time(old); time(current);
  const prior: number[] = [], next: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    if (index % 2) { next.push(time(current)); prior.push(time(old)); }
    else { prior.push(time(old)); next.push(time(current)); }
  }
  return { beforeMedianMs: median(prior), afterMedianMs: median(next), speedup: median(prior) / median(next) };
};
console.log(JSON.stringify({ revision, comparisons, workload: { utf16Units: value.length, utf8Bytes: utf8ByteLength(value), budget, pairedIterations: iterations }, prefix: measure(before.truncateUtf8, truncateUtf8), tail: measure(before.truncateUtf8Tail, truncateUtf8Tail) }, null, 2));
