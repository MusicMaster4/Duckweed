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

function render(workingTabIds: ReadonlySet<string>): string {
  const noop = () => {};
  return renderToStaticMarkup(
    <TabStrip
      tabs={tabs}
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
  test("renders the shimmer only on tabs with active agent work", () => {
    const html = render(new Set(["tab-working"]));

    expect(html.match(/tab-work-shimmer/g)).toHaveLength(1);
    expect(html).toContain("tab is-active is-unclaimed is-agent-working");
    expect(html).toContain('aria-label="Duckweed, agent working"');
  });

  test("does not render a shimmer when every agent is idle", () => {
    expect(render(new Set())).not.toContain("tab-work-shimmer");
  });
});
