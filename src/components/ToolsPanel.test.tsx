import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ChecklistTool } from "./ChecklistTool";
import { LayoutsTool } from "./LayoutsTool";
import { PortsTool, portsForOwners } from "./PortsTool";
import type { AppPort } from "../lib/ipc";
import { PowerWatchTool } from "./PowerWatchTool";
import { StatisticsTool } from "./StatisticsTool";
import * as checklist from "../lib/checklist";
import * as layouts from "../lib/layouts";
import * as powerWatch from "../lib/powerWatch";

const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  checklist.resetForTests();
  layouts.resetLayoutsForTests();
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
      tab1: [
        {
          id: "a",
          text: "done thing",
          createdAt: 0,
          // Keep away from the exact hour boundary so time spent rendering
          // cannot change the floored label from 23h to 22h.
          doneAt: Date.now() - DAY / 24 + 60_000,
        },
      ],
    });
    const html = renderToStaticMarkup(<ChecklistTool scope="tab1" scopeLabel="duckweed" />);
    // Checked just under an hour ago, so 23 whole hours are left.
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

describe("layouts panel", () => {
  test("focuses on creating and saving personal layouts", () => {
    const html = renderToStaticMarkup(
      <LayoutsTool
        projectName="duckweed"
        getCurrentDraft={() => null}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain("Create");
    expect(html).toContain("Save current");
    expect(html).not.toContain("Quick layouts");
  });

  test("marks the layout selected for startup", () => {
    const saved = layouts.saveLayout({
      name: "Daily agents",
      root: layouts.gridTemplate(["codex", "claude"]),
    });
    if (!saved) throw new Error("expected a saved layout");
    layouts.setDefaultLayout(saved.id);

    const html = renderToStaticMarkup(
      <LayoutsTool
        projectName="duckweed"
        getCurrentDraft={() => null}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain("Daily agents");
    expect(html).toContain("Default");
    expect(html).toContain("Used when Duckweed starts");
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
    expect(html).toContain("Still running");
    expect(html).toContain("duckweed · claude");
    expect(html).toContain("needs you");
    expect(html).toContain("Cancel");
    // Each busy row is a control that jumps the UI to that pane.
    expect(html).toContain('class="power-busy"');
    expect(html).toContain("Click a row to jump to that pane");
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
    expect(html).toContain("Shutting down in");
    expect(html).toContain("Cancel");
  });

  test("the active countdown card sits above the plan", () => {
    powerWatch.resetForTests({
      phase: "countdown",
      firesAt: Date.now() + 95_000,
      action: "shutdown",
    });
    const html = renderToStaticMarkup(<PowerWatchTool />);
    expect(html.indexOf("power-card is-counting")).toBeLessThan(
      html.indexOf("When the work is done"),
    );
  });

  test("a refused action is reported rather than swallowed", () => {
    powerWatch.resetForTests({ phase: "failed", error: "Windows refused the sleep request" });
    const html = renderToStaticMarkup(<PowerWatchTool />);
    expect(html).toContain("The OS refused");
    expect(html).toContain("Windows refused the sleep request");
  });
});

describe("statistics and ports panels", () => {
  const appPort = (owner_id: string, port: number): AppPort => ({
    pid: port,
    port,
    address: "127.0.0.1",
    process: "node",
    owner_id,
    owner_kind: "terminal",
    forward: null,
  });

  test("statistics leads with what this session cost, not a 7-day total", () => {
    const html = renderToStaticMarkup(<StatisticsTool tabs={3} panes={5} projects={2} />);
    expect(html).toContain("Estimated cost");
    expect(html).toContain("Since this window opened");
    expect(html).not.toContain("Last 7 days");
    expect(html).toContain(">3<");
    expect(html).toContain("Panes");
    expect(html).toContain(">5<");
  });

  test("statistics says a quiet session is quiet rather than showing a stale number", () => {
    const html = renderToStaticMarkup(<StatisticsTool tabs={1} panes={1} projects={1} />);
    expect(html).toContain("$0");
    expect(html).toContain("Reading transcripts...");
  });

  test("ports warns about public sharing before any server is found", () => {
    const html = renderToStaticMarkup(<PortsTool ownerNames={new Map()} />);
    expect(html).toContain("Anyone with a public link");
    expect(html).toContain("over the internet");
  });

  test("ports includes only process owners from the visible tab", () => {
    const ports = [appPort("tab-a-pane-1", 3000), appPort("tab-b-pane-1", 4000)];
    const visibleOwners = new Map([["tab-a-pane-1", "Project A"]]);

    expect(portsForOwners(ports, visibleOwners).map((port) => port.port)).toEqual([3000]);
  });

  test("ports labels its scope as the visible tab", () => {
    const html = renderToStaticMarkup(<PortsTool ownerNames={new Map()} />);
    expect(html).toContain("This tab&#x27;s servers");
  });
});
