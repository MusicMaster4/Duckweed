import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Tab } from "../lib/types";
import { TabStrip } from "./TabStrip";

const tabs: Tab[] = [
  {
    id: "tab-working",
    title: "Duckweed",
    root: { kind: "leaf", id: "leaf-working", term: "term-working" },
    activeLeaf: "leaf-working",
    zoomedLeaf: null,
    project: null,
  },
  {
    id: "tab-idle",
    title: "VPS",
    root: { kind: "leaf", id: "leaf-idle", term: "term-idle" },
    activeLeaf: "leaf-idle",
    zoomedLeaf: null,
    project: null,
  },
];

function render(workingTabIds: ReadonlySet<string>, displayTabs = tabs): string {
  const noop = () => {};
  return renderToStaticMarkup(
    <TabStrip
      tabs={displayTabs}
      activeTabId="tab-working"
      paneCounts={{ "tab-working": 1, "tab-idle": 1 }}
      workingTabIds={workingTabIds}
      unreadCounts={{}}
      completionReviewFlashes={{}}
      completionHighlights
      drag={null}
      projects={{ recents: [], setFor: noop, browseFor: noop }}
      allowNewTab={false}
      onSelect={noop}
      onClose={noop}
      onCloseOthers={noop}
      onNew={noop}
      onReorder={noop}
      onRename={noop}
      onPin={noop}
      onColor={noop}
      onIcon={noop}
      settingsOpen={false}
      settingsActive={false}
      settingsIndex={0}
      onSelectSettings={noop}
      onCloseSettings={noop}
    />,
  );
}

describe("TabStrip agent activity", () => {
  test("does not render the shimmer on the focused tab", () => {
    const html = render(new Set(["tab-working"]));

    expect(html).not.toContain("tab-work-shimmer");
    expect(html).toContain("tab is-active is-unclaimed is-agent-working");
    expect(html).toContain('aria-label="Duckweed, agent working"');
  });

  test("renders the shimmer when working tab is in the background", () => {
    const html = render(new Set(["tab-idle"]));

    expect(html.match(/tab-work-shimmer/g)).toHaveLength(1);
    expect(html).toContain('aria-label="VPS, agent working"');
  });

  test("does not render a shimmer when every agent is idle", () => {
    expect(render(new Set())).not.toContain("tab-work-shimmer");
  });
});


describe("TabStrip groups", () => {
  const grouped = (collapsed: boolean) => tabs.map((tab) => ({ ...tab, group: { id: "work", name: "Work", collapsed } }));

  test("members inherit group color while explicit tab colors take priority", () => {
    const colored = grouped(false).map((tab, index) => ({ ...tab, color: index === 0 ? "rose" : null, group: { ...tab.group, color: "teal" } }));
    const html = render(new Set(), colored);
    expect(html).toContain('--group-color:#45cec4');
    expect(html).toContain('--tab-color:#45cec4');
    expect(html).toContain('--tab-color:#f2686f');
  });

  test("collapsed group hides its tabs and aggregates work on the focused tab", () => {
    const html = render(new Set(["tab-working"]), grouped(true));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Work, 2 tabs, agent working"');
    expect(html.match(/tab-work-shimmer/g)).toHaveLength(1);
    expect(html).not.toContain('data-tab-id=');
  });

  test("expanded group renders one label and all its tabs", () => {
    const html = render(new Set(["tab-idle"]), grouped(false));
    expect(html.match(/data-group-id=/g)).toHaveLength(1);
    expect(html.match(/data-tab-id=/g)).toHaveLength(2);
    expect(html.match(/tab-work-shimmer/g)).toHaveLength(2);
    expect(html).toContain('aria-expanded="true"');
  });

  test("idle collapsed group has no shimmer", () => {
    expect(render(new Set(), grouped(true))).not.toContain("tab-work-shimmer");
  });
});
