import { describe, expect, test } from "bun:test";

import { DESKTOP_ACTIVITY_EVENTS, observeDesktopActivity } from "./desktopActivity";

describe("desktop activity observation", () => {
  test("counts cursor movement and every other supported input while focused", () => {
    const target = new EventTarget();
    const seen: string[] = [];
    const stop = observeDesktopActivity(target, () => true, () => seen.push("activity"));

    for (const type of DESKTOP_ACTIVITY_EVENTS) target.dispatchEvent(new Event(type));

    expect(seen).toHaveLength(DESKTOP_ACTIVITY_EVENTS.length);
    expect(DESKTOP_ACTIVITY_EVENTS).toContain("pointermove");
    expect(DESKTOP_ACTIVITY_EVENTS).toContain("keydown");

    stop();
    target.dispatchEvent(new Event("pointermove"));
    expect(seen).toHaveLength(DESKTOP_ACTIVITY_EVENTS.length);
  });

  test("ignores input while the desktop window is not focused", () => {
    const target = new EventTarget();
    let focused = false;
    let activities = 0;
    observeDesktopActivity(target, () => focused, () => { activities += 1; });

    target.dispatchEvent(new Event("pointermove"));
    focused = true;
    target.dispatchEvent(new Event("pointermove"));

    expect(activities).toBe(1);
  });
});
