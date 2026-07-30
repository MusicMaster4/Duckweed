import { describe, expect, test } from "bun:test";

import { cKeyAction, isApplePlatform, isAppModifier, isControlChord } from "./platform";

describe("isApplePlatform", () => {
  test("detects classic Mac platform strings", () => {
    expect(isApplePlatform("MacIntel", "")).toBe(true);
    expect(isApplePlatform("MacARM64", "")).toBe(true);
    expect(isApplePlatform("iPhone", "")).toBe(true);
  });

  test("rejects Windows and Linux", () => {
    expect(isApplePlatform("Win32", "Windows")).toBe(false);
    expect(isApplePlatform("Linux x86_64", "Linux")).toBe(false);
  });
});

describe("cKeyAction", () => {
  const ctrl = { ctrlKey: true, metaKey: false };
  const cmd = { ctrlKey: false, metaKey: true };
  const both = { ctrlKey: true, metaKey: true };
  const shiftCtrl = { ctrlKey: true, metaKey: false, shiftKey: true };

  test("on Apple: Cmd+C copies only with a selection", () => {
    expect(cKeyAction(cmd, true, true)).toBe("copy");
    expect(cKeyAction(cmd, false, true)).toBe(null);
  });

  test("on Apple: Ctrl+C is always terminal control", () => {
    expect(cKeyAction(ctrl, true, true)).toBe("control");
    expect(cKeyAction(ctrl, false, true)).toBe("control");
  });

  test("on Windows/Linux: Ctrl+C copies with selection, otherwise control", () => {
    expect(cKeyAction(ctrl, true, false)).toBe("copy");
    expect(cKeyAction(ctrl, false, false)).toBe("control");
    expect(cKeyAction(cmd, true, false)).toBe(null);
  });

  test("ignores Shift/Alt and Ctrl+Cmd chords", () => {
    expect(cKeyAction(shiftCtrl, true, false)).toBe(null);
    expect(cKeyAction(both, true, true)).toBe(null);
    expect(cKeyAction(both, true, false)).toBe(null);
  });
});

describe("isControlChord", () => {
  test("requires physical Control without Command", () => {
    expect(isControlChord({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(isControlChord({ ctrlKey: false, metaKey: true })).toBe(false);
    expect(isControlChord({ ctrlKey: true, metaKey: true })).toBe(false);
  });
});

describe("isAppModifier", () => {
  test("accepts either modifier on every platform for app shortcuts", () => {
    expect(isAppModifier({ ctrlKey: true, metaKey: false }, true)).toBe(true);
    expect(isAppModifier({ ctrlKey: false, metaKey: true }, true)).toBe(true);
    expect(isAppModifier({ ctrlKey: true, metaKey: false }, false)).toBe(true);
    expect(isAppModifier({ ctrlKey: false, metaKey: true }, false)).toBe(true);
  });
});
