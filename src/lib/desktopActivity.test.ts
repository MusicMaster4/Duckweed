import { describe, expect, test } from "bun:test";

import { DESKTOP_ACTIVITY_EVENTS, observeDesktopActivity } from "./desktopActivity";

describe("desktop activity observation", () => {
  test("counts cursor movement and every other supported input while focused", () => {
    const target = new EventTarget();
    const seen: string[] = [];
    const stop = observeDesktopActivity(target, () => seen.push("activity"));

    for (const type of DESKTOP_ACTIVITY_EVENTS) target.dispatchEvent(new Event(type));

    expect(seen).toHaveLength(DESKTOP_ACTIVITY_EVENTS.length);
    expect(DESKTOP_ACTIVITY_EVENTS).toContain("pointermove");
    expect(DESKTOP_ACTIVITY_EVENTS).toContain("mousemove");
    expect(DESKTOP_ACTIVITY_EVENTS).toContain("keydown");

    stop();
    target.dispatchEvent(new Event("pointermove"));
    expect(seen).toHaveLength(DESKTOP_ACTIVITY_EVENTS.length);
  });

  test("counts hover movement even before the native window gains focus", () => {
    const target = new EventTarget();
    let activities = 0;
    observeDesktopActivity(target, () => { activities += 1; });

    target.dispatchEvent(new Event("pointermove"));
    target.dispatchEvent(new Event("mousemove"));

    expect(activities).toBe(2);
  });
});
