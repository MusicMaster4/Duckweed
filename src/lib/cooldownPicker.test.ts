import { describe, expect, test } from "bun:test";

import { createCooldownPicker } from "./cooldownPicker";

describe("createCooldownPicker", () => {
  test("keeps a selected item out of the next half-pool of picks", () => {
    const items = Array.from({ length: 10 }, (_, index) => index);
    const pick = createCooldownPicker(items, -1, () => 0);
    const selected = Array.from({ length: 30 }, () => pick());

    selected.forEach((item, index) => {
      const protectedWindow = selected.slice(Math.max(0, index - 5), index);
      expect(protectedWindow).not.toContain(item);
    });
  });

  test("returns the fallback for an empty collection", () => {
    const pick = createCooldownPicker<string>([], "fallback");
    expect(pick()).toBe("fallback");
  });

  test("supports a single-item collection", () => {
    const pick = createCooldownPicker(["only"], "fallback");
    expect(pick()).toBe("only");
    expect(pick()).toBe("only");
  });
});
