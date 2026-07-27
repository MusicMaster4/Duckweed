import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ChecklistTool } from "./ChecklistTool";
import { PowerWatchTool } from "./PowerWatchTool";
import * as checklist from "../lib/checklist";
import * as powerWatch from "../lib/powerWatch";

const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  checklist.resetForTests();
  powerWatch.resetForTests();
});

describe("checklist panel", () => {
  test("an empty list explains what the tool is for rather than just saying it is empty", () => {
    const html = renderToStaticMarkup(<ChecklistTool scope="tab1" scopeLabel="duckweed" />);
    expect(html).toContain("Nothing on the list");
    expect(html).toContain("clear themselves");
    // The tab a list belongs to is named on screen, not only in a tooltip.
    expect(html).toContain("duckweed");
  });

  test("open items are listed and counted against the total", () => {
    checklist.resetForTests({
      tab1: [
        { id: "a", text: "ship the dock", createdAt: 0, doneAt: null },
        { id: "b", text: "write the tests", createdAt: 1, doneAt: Date.now() },
      ],
    });
    const html = renderToStaticMarkup(<ChecklistTool scope="tab1" scopeLabel="duckweed" />);
    expect(html).toContain("ship the dock");
    expect(html).toContain("write the tests");
    expect(html).toContain("1/2");
    // Finished items are grouped, with their own count.
    expect(html).toContain("Done (1)");
  });

  test("a finished item says on the row how long it has left", () => {
    checklist.resetForTests({
      tab1: [{ id: "a", text: "done thing", createdAt: 0, doneAt: Date.now() - DAY / 24 }],
    });
    const html = renderToStaticMarkup(<ChecklistTool scope="tab1" scopeLabel="duckweed" />);
    // Checked an hour ago, so 23 of its 24 hours are left.
    expect(html).toContain("check-expiry");
    expect(html).toContain(">23h<");
  });

  test("a list that is entirely finished still says so", () => {
    checklist.resetForTests({
      tab1: [{ id: "a", text: "done thing", createdAt: 0, doneAt: Date.now() }],
    });
    expect(renderToStaticMarkup(<ChecklistTool scope="tab1" scopeLabel="duckweed" />)).toContain(
      "All clear",
    );
  });

  test("no tab means no list to show", () => {
    expect(renderToStaticMarkup(<ChecklistTool scope={null} scopeLabel="" />)).toContain(
      "No tab to keep a list for",
    );
  });
});

describe("power watch panel", () => {
  test("resting state explains both actions inline instead of behind a hover", () => {
    const html = renderToStaticMarkup(<PowerWatchTool />);
    expect(html).toContain("Sleep");
    expect(html).toContain("Shut down");
    expect(html).toContain("still here when the machine wakes");
    expect(html).toContain("Arm sleep");
    // The one thing a user must know before walking away.
    expect(html).toContain("session only");
  });

  test("an armed watch names what it is waiting on", () => {
    powerWatch.resetForTests({
      phase: "armed",
      busy: [{ termId: "t1", label: "duckweed · claude", reason: "agent-waiting" }],
    });
    const html = renderToStaticMarkup(<PowerWatchTool />);
    expect(html).toContain("Waiting for the work to finish");
    expect(html).toContain("duckweed · claude");
    expect(html).toContain("needs you");
    expect(html).toContain("Cancel");
    // Arming is not offered twice.
    expect(html).not.toContain("Arm sleep");
  });

  test("the countdown leads with the time left", () => {
    powerWatch.resetForTests({
      phase: "countdown",
      firesAt: Date.now() + 95_000,
      action: "shutdown",
    });
    const html = renderToStaticMarkup(<PowerWatchTool />);
    expect(html).toMatch(/1:3[45]/);
    expect(html).toContain("until shut down");
    expect(html).toContain("Cancel");
  });

  test("the active countdown card appears below the activity readout", () => {
    powerWatch.resetForTests({
      phase: "countdown",
      firesAt: Date.now() + 95_000,
      action: "shutdown",
    });
    const html = renderToStaticMarkup(<PowerWatchTool />);
    expect(html.indexOf("Nothing running")).toBeLessThan(html.indexOf("power-hero is-counting"));
  });

  test("a refused action is reported rather than swallowed", () => {
    powerWatch.resetForTests({ phase: "failed", error: "Windows refused the sleep request" });
    const html = renderToStaticMarkup(<PowerWatchTool />);
    expect(html).toContain("The OS refused");
    expect(html).toContain("Windows refused the sleep request");
  });
});
