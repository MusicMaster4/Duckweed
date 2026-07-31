import { describe, expect, test } from "bun:test";

import { parseOsc133 } from "./osc133";

describe("parseOsc133", () => {
  test("parses prompt and lifecycle markers", () => {
    expect(parseOsc133("A")).toEqual({ kind: "prompt-start" });
    expect(parseOsc133("B")).toEqual({ kind: "prompt-end" });
    expect(parseOsc133("C")).toEqual({ kind: "command-start", command: null });
    expect(parseOsc133("D;17")).toEqual({ kind: "command-end", exitCode: 17 });
  });

  test("decodes the UTF-8 command extension", () => {
    expect(parseOsc133("C;cmd=V3JpdGUtT3V0cHV0ICfDoWwgw6kn")).toEqual({
      kind: "command-start",
      command: "Write-Output 'ál é'",
    });
  });

  test("rejects unrelated or malformed values without throwing", () => {
    expect(parseOsc133("X;anything")).toBeNull();
    expect(parseOsc133("C;cmd=%%%")) .toEqual({ kind: "command-start", command: null });
    expect(parseOsc133("D;nope")).toEqual({ kind: "command-end", exitCode: null });
  });
});
