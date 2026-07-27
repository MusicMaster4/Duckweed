import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

import { ChangesPanel } from "./components/ChangesPanel";
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { FileEditor } from "./components/FileEditor";
import { PaneTree, type PaneTreeShared } from "./components/PaneTree";
import { StatusBar } from "./components/StatusBar";
import { TabStrip } from "./components/TabStrip";
import { TitleBar } from "./components/TitleBar";
import { SettingsMenu } from "./components/SettingsMenu";
import { ToolsPanel, TOOLS_MAX_WIDTH, TOOLS_MIN_WIDTH } from "./components/ToolsPanel";
import { ConfirmCloseDialog } from "./components/ConfirmCloseDialog";
import { UpdateDialog } from "./components/UpdateDialog";
import { useDragPane, type DragState } from "./hooks/useDragPane";
import { useGitChanges } from "./hooks/useGitChanges";
import { useUpdater } from "./hooks/useUpdater";
import * as bus from "./lib/bus";
import {
  confirmCloseRunning,
  isConfirmCloseRunningEnabled,
  setConfirmCloseRunningEnabled,
  subscribeConfirmClosePref,
} from "./lib/confirmClose";
import { playCompletionSound, preloadCompletionSound } from "./lib/completionSound";
import * as commandHistory from "./lib/commandHistory";
import { clearGreetings } from "./lib/greetings";
import {
  frontendReady,
  listShells,
  projectInfo,
  shellIntegrationSet,
  shellIntegrationStatus,
  takeLaunchIntent,
  watchProject,
  type LaunchIntent,
  type ShellIntegrationStatus,
} from "./lib/ipc";
import {
  balance,
  findLeaf,
  insertBeside,
  leaf,
  leaves,
  nextLeaf,
  removeLeaf,
  setSizes,
  swapLeaves,
  uid,
} from "./lib/layout";
import { toggleFullscreen } from "./lib/window";
import { DEFAULT_TOOLS_WIDTH, load, pushRecent, rehydrate, save } from "./lib/persist";
import {
  shouldPlayCompletionSound,
  shouldSignalCompletion,
  type ProcessState,
} from "./lib/processActivity";
import {
  adjustSettingsIndexOnAppend,
  adjustSettingsIndexOnClose,
  applyStripReorder,
} from "./lib/tabReorder";
import * as terminals from "./lib/terminals";
import { loadSettings as loadUsageSettings, prefetchUsage } from "./lib/usage";
import type { LeafNode, ProjectInfo, ShellInfo, Tab } from "./lib/types";

interface SpawnOpts {
  cwd: string | null;
  shell: string | null;
}

const DEFAULT_FONT_SIZE = 13.5;
const TAURI_RUNTIME = "__TAURI_INTERNALS__" in window;

async function confirmUpdateWithRunningProcesses(): Promise<boolean> {
  const hasRunningProcesses = await terminals.anyHasRunningProcess(terminals.allSessionIds());
  if (!hasRunningProcesses) return true;
  return confirmCloseRunning({
    title: "Install update?",
    message:
      "Some terminals still have running processes. If you update now, their progress will be lost.",
    confirmLabel: "Update anyway",
  });
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Stand-in for a restored tab's project until `project_info` answers. The folder
 * name is all the chrome needs to draw, and the branch arrives a tick later.
 */
function provisionalProject(path: string): ProjectInfo {
  return { path, name: basename(path), branch: null, is_git: false };
}

/** True for a title nobody chose, so pointing the tab at a folder may rename it. */
function isAutoTitle(tab: Tab): boolean {
  return /^Terminal \d+$/.test(tab.title) || tab.title === tab.project?.name;
}

function boot() {
  const saved = load();
  if (saved && saved.tabs.length > 0) {
    const tabs: Tab[] = saved.tabs.map((entry, i) => {
      const root = rehydrate(entry.root);
      return {
        id: uid("tab"),
        title: entry.title || `Terminal ${i + 1}`,
        root,
        activeLeaf: leaves(root)[0].id,
        zoomedLeaf: null,
        project: entry.project ? provisionalProject(entry.project) : null,
        pinned: entry.pinned === true,
        color: entry.color ?? null,
        icon: entry.icon ?? null,
      };
    });
    const index = Math.min(Math.max(0, saved.activeTabIndex), tabs.length - 1);
    return {
      tabs,
      activeTabId: tabs[index].id,
      lastProject: saved.project,
      recents: saved.recents,
      fontSize: saved.fontSize,
      shell: saved.shell,
      highlight: saved.highlight,
      completionHighlights: saved.completionHighlights,
      completionSoundEnabled: saved.completionSoundEnabled,
      customAgentUi: saved.customAgentUi,
      inputMode: saved.inputMode,
      confirmCloseRunning: saved.confirmCloseRunning,
      toolsOpen: saved.toolsOpen,
      toolsWidth: saved.toolsWidth,
    };
  }
  const term = terminals.newTermId();
  const root = leaf(term);
  const tab: Tab = {
    id: uid("tab"),
    title: "Terminal 1",
    root,
    activeLeaf: root.id,
    zoomedLeaf: null,
    project: null,
  };
  return {
    tabs: [tab],
    activeTabId: tab.id,
    lastProject: null as string | null,
    recents: [] as string[],
    fontSize: DEFAULT_FONT_SIZE,
    shell: null as string | null,
    highlight: true,
    completionHighlights: true,
    completionSoundEnabled: true,
    customAgentUi: true,
    inputMode: "editor" as terminals.InputMode,
    confirmCloseRunning: true,
    toolsOpen: false,
    toolsWidth: DEFAULT_TOOLS_WIDTH,
  };
}

/** Stable empty set so hiding completion marks does not churn PaneTree memos. */
const NO_UNREAD_TERMS: ReadonlySet<string> = new Set();
/** Stable empty map used while focused completion flashes are hidden. */
const NO_COMPLETION_FLASHES: ReadonlyMap<string, number> = new Map();

/**
 * True for a field the user is typing into. xterm's hidden helper textarea is
 * not one of those — it is how the terminal itself receives keys.
 */
function isTextField(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) return true;
  return target instanceof HTMLTextAreaElement && !target.classList.contains("xterm-helper-textarea");
}

export default function App() {
  const initial = useMemo(boot, []);

  const [tabs, setTabs] = useState<Tab[]>(initial.tabs);
  const [activeTabId, setActiveTabId] = useState(initial.activeTabId);
  const [recents, setRecents] = useState<string[]>(initial.recents);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [shell, setShell] = useState<string | null>(initial.shell);
  const [fontSize, setFontSize] = useState(initial.fontSize);
  const [highlight, setHighlight] = useState(initial.highlight);
  const [completionHighlights, setCompletionHighlights] = useState(initial.completionHighlights);
  const [completionSoundEnabled, setCompletionSoundEnabled] = useState(
    initial.completionSoundEnabled,
  );
  const [customAgentUi, setCustomAgentUi] = useState(initial.customAgentUi);
  const [inputMode, setInputMode] = useState(initial.inputMode);
  const [confirmCloseRunningPref, setConfirmCloseRunningPref] = useState(() => {
    // Honour the saved preference before any close handler can run.
    setConfirmCloseRunningEnabled(initial.confirmCloseRunning);
    return initial.confirmCloseRunning;
  });
  /** null = not Windows / unknown; settings hides the rows until we know. */
  const [explorerIntegration, setExplorerIntegration] = useState<ShellIntegrationStatus | null>(
    null,
  );
  const [booted, setBooted] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsTabOpen, setSettingsTabOpen] = useState(false);
  const [settingsActive, setSettingsActive] = useState(false);
  /** Where Settings sits among strip items (0..tabs.length). */
  const [settingsTabIndex, setSettingsTabIndex] = useState(0);
  const [changesOpen, setChangesOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(initial.toolsOpen);
  const [unreadTermIds, setUnreadTermIds] = useState<Set<string>>(() => new Set());
  const [completionFlashes, setCompletionFlashes] = useState<Map<string, number>>(
    () => new Map(),
  );
  const [toolsWidth, setToolsWidth] = useState(
    Math.min(TOOLS_MAX_WIDTH, Math.max(TOOLS_MIN_WIDTH, initial.toolsWidth)),
  );
  /**
   * Popup file editor path. Held here (not inside the tools panel) so Ctrl+Tab,
   * hiding the explorer, or opening settings cannot unmount a dirty buffer.
   */
  const [openFile, setOpenFile] = useState<string | null>(null);
  const updater = useUpdater({ beforeInstall: confirmUpdateWithRunningProcesses });

  // Handlers read state through refs so keyboard shortcuts and pointer drags
  // never act on a stale snapshot.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const settingsActiveRef = useRef(settingsActive);
  settingsActiveRef.current = settingsActive;
  const settingsTabOpenRef = useRef(settingsTabOpen);
  settingsTabOpenRef.current = settingsTabOpen;
  const settingsTabIndexRef = useRef(settingsTabIndex);
  settingsTabIndexRef.current = settingsTabIndex;
  const shellRef = useRef(shell);
  shellRef.current = shell;
  const completionSoundEnabledRef = useRef(completionSoundEnabled);
  completionSoundEnabledRef.current = completionSoundEnabled;
  const completionHighlightsRef = useRef(completionHighlights);
  completionHighlightsRef.current = completionHighlights;
  const completionFlashSeq = useRef(0);
  const completionFlashTimers = useRef(new Map<string, number>());
  /** Dirty flag for the lifted file editor (file switches confirm through this). */
  const editorDirtyRef = useRef(false);
  const processState = useRef(new Map<string, ProcessState>());
  /** Last folder opened in any tab — only ever used to seed the folder picker. */
  const lastProject = useRef<string | null>(initial.lastProject);

  /** Spawn parameters for terminals that have not been created yet. */
  const spawnOpts = useRef(new Map<string, SpawnOpts>());

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const project = activeTab?.project ?? null;
  const changes = useGitChanges(project);

  const currentTab = useCallback(
    () => tabsRef.current.find((t) => t.id === activeTabIdRef.current) ?? tabsRef.current[0] ?? null,
    [],
  );

  const updateTab = useCallback((tabId: string, fn: (tab: Tab) => Tab) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? fn(t) : t)));
  }, []);

  const acknowledgeTerm = useCallback((termId: string) => {
    setUnreadTermIds((prev) => {
      if (!prev.has(termId)) return prev;
      const next = new Set(prev);
      next.delete(termId);
      return next;
    });
  }, []);

  const flashFocusedCompletion = useCallback((termId: string) => {
    const previousTimer = completionFlashTimers.current.get(termId);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);

    const pulse = ++completionFlashSeq.current;
    setCompletionFlashes((previous) => {
      const next = new Map(previous);
      next.set(termId, pulse);
      return next;
    });

    completionFlashTimers.current.set(
      termId,
      window.setTimeout(() => {
        completionFlashTimers.current.delete(termId);
        setCompletionFlashes((previous) => {
          if (!previous.has(termId)) return previous;
          const next = new Map(previous);
          next.delete(termId);
          return next;
        });
      }, 1500),
    );
  }, []);

  /** Active leaf of the active tab — used for the completion sound (works unfocused). */
  const isSelectedTerm = useCallback((termId: string): boolean => {
    const tab = tabsRef.current.find((candidate) =>
      leaves(candidate.root).some((node) => node.term === termId),
    );
    if (!tab || tab.id !== activeTabIdRef.current) return false;
    return findLeaf(tab.root, tab.activeLeaf)?.term === termId;
  }, []);

  /** Selected pane while the user is actually looking at the window (flash vs unread). */
  const isFocusedTerm = useCallback(
    (termId: string): boolean => {
      if (!document.hasFocus() || settingsActiveRef.current) return false;
      return isSelectedTerm(termId);
    },
    [isSelectedTerm],
  );

  /** cwd a new pane should start in: follow the focused shell, then the tab's project. */
  const inheritCwd = useCallback((): string | null => {
    const tab = currentTab();
    if (!tab) return null;
    const active = findLeaf(tab.root, tab.activeLeaf);
    const meta = active ? terminals.getMeta(active.term) : null;
    if (meta?.cwd) return meta.cwd;
    return tab.project?.path ?? null;
  }, [currentTab]);

  const createTerm = useCallback(
    (opts?: Partial<SpawnOpts>) => {
      const term = terminals.newTermId();
      spawnOpts.current.set(term, {
        cwd: opts?.cwd !== undefined ? opts.cwd : inheritCwd(),
        shell: opts?.shell !== undefined ? opts.shell : shellRef.current,
      });
      return term;
    },
    [inheritCwd],
  );

  const spawnFor = useCallback((term: string): SpawnOpts => {
    const recorded = spawnOpts.current.get(term);
    if (recorded) return recorded;
    // A pane restored from disk records nothing, so its folder is the one
    // belonging to the tab it was restored into — not whichever tab is active.
    const owner = tabsRef.current.find((t) => leaves(t.root).some((n) => n.term === term));
    return { cwd: owner?.project?.path ?? null, shell: shellRef.current };
  }, []);

  const releaseTerm = useCallback((term: string) => {
    terminals.dispose(term);
    spawnOpts.current.delete(term);
    processState.current.delete(term);
    const flashTimer = completionFlashTimers.current.get(term);
    if (flashTimer !== undefined) {
      window.clearTimeout(flashTimer);
      completionFlashTimers.current.delete(term);
    }
    setCompletionFlashes((previous) => {
      if (!previous.has(term)) return previous;
      const next = new Map(previous);
      next.delete(term);
      return next;
    });
    acknowledgeTerm(term);
    clearGreetings(term);
  }, [acknowledgeTerm]);

  const termIds = useMemo(
    () => tabs.flatMap((tab) => leaves(tab.root).map((node) => node.term)),
    [tabs],
  );
  const termIdsKey = termIds.join("\0");

  // Background tabs remain subscribed to the app-wide PTY busy monitor so a
  // running -> idle transition can leave a durable "not reviewed yet" marker.
  useEffect(() => {
    const readState = (termId: string) => {
      const meta = terminals.getMeta(termId);
      if (!meta) {
        processState.current.delete(termId);
        acknowledgeTerm(termId);
        return;
      }

      const previous = processState.current.get(termId);
      const current = {
        busy: meta.busy,
        exited: meta.exited,
        completionSeq: meta.completionSeq,
        agent: meta.agent,
        agentUi: meta.agentUi !== null,
        processStartedAt: meta.processStartedAt,
      };
      processState.current.set(termId, current);
      if (!previous) return;

      if (!shouldSignalCompletion(previous, current)) return;
      // Sound on the selected pane even when the window is in the background —
      // that is when a long-job cue is most useful. Still quiet for other panes.
      if (
        completionSoundEnabledRef.current &&
        isSelectedTerm(termId) &&
        shouldPlayCompletionSound(previous, current)
      ) {
        playCompletionSound();
      }
      if (isFocusedTerm(termId)) {
        if (completionHighlightsRef.current) flashFocusedCompletion(termId);
        return;
      }
      setUnreadTermIds((prev) => {
        if (prev.has(termId)) return prev;
        const next = new Set(prev);
        next.add(termId);
        return next;
      });
    };

    const unsubscribers = termIds.map((termId) => {
      readState(termId);
      return terminals.subscribeSession(termId, () => readState(termId));
    });
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
    // Tab metadata changes must not tear down every terminal subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termIdsKey, acknowledgeTerm, flashFocusedCompletion, isFocusedTerm, isSelectedTerm]);

  // ---------------------------------------------------------------- tabs

  // Like Warp's default new-tab action, this opens a fresh shell in the
  // configured default directory (the backend resolves null to the user's
  // home). Choosing a project is an explicit action on this tab.
  const newTab = useCallback(
    (shellId?: string | null) => {
      const previousCount = tabsRef.current.length;
      const term = createTerm({ cwd: null, shell: shellId ?? shellRef.current });
      const root = leaf(term);
      const tab: Tab = {
        id: uid("tab"),
        title: `Terminal ${previousCount + 1}`,
        root,
        activeLeaf: root.id,
        zoomedLeaf: null,
        project: null,
      };
      setTabs([...tabsRef.current, tab]);
      setActiveTabId(tab.id);
      setSettingsActive(false);
      if (settingsTabOpenRef.current) {
        setSettingsTabIndex((i) => adjustSettingsIndexOnAppend(i, previousCount));
      }
    },
    [createTerm],
  );

  const closeTab = useCallback(
    async (tabId: string, skipTerms: string[] = []) => {
      const prev = tabsRef.current;
      const tab = prev.find((t) => t.id === tabId);
      if (!tab) return;

      // Pinned tabs always ask first — they are sticky by design.
      if (tab.pinned) {
        const ok = await confirmCloseRunning({
          title: "Close pinned tab?",
          message: `“${tab.title}” is pinned. Close it anyway?`,
          confirmLabel: "Yes, close",
        });
        if (!ok) return;
      }

      const termsToCheck = leaves(tab.root)
        .map((n) => n.term)
        .filter((t) => !skipTerms.includes(t));
      if (await terminals.anyHasRunningProcess(termsToCheck)) {
        const agent = terminals.runningAgentLabel(termsToCheck);
        const ok = await confirmCloseRunning({
          title: "Close tab?",
          message: agent
            ? `${agent} is still open in this tab. Closing ends the session.`
            : termsToCheck.length === 1
              ? "You have a process running in this tab."
              : "You have processes running in this tab.",
          confirmLabel: "Yes, close",
          allowDontShowAgain: true,
        });
        if (!ok) return;
      }

      // Re-read after the dialog — the user may have restructured tabs meanwhile.
      const latest = tabsRef.current;
      const still = latest.find((t) => t.id === tabId);
      if (!still) return;

      for (const node of leaves(still.root)) {
        if (!skipTerms.includes(node.term)) releaseTerm(node.term);
      }
      const index = latest.findIndex((t) => t.id === tabId);
      const remaining = latest.filter((t) => t.id !== tabId);

      if (settingsTabOpenRef.current && index >= 0) {
        setSettingsTabIndex((i) => adjustSettingsIndexOnClose(i, index));
      }

      if (remaining.length === 0) {
        // The window keeps one neutral tab open in the default directory.
        const term = createTerm({ cwd: null });
        const root = leaf(term);
        const fresh: Tab = {
          id: uid("tab"),
          title: "Terminal 1",
          root,
          activeLeaf: root.id,
          zoomedLeaf: null,
          project: null,
        };
        setTabs([fresh]);
        setActiveTabId(fresh.id);
        // Settings can only sit at 0 or 1 with a single tab left.
        if (settingsTabOpenRef.current) setSettingsTabIndex((i) => Math.min(i, 1));
        return;
      }

      setTabs(remaining);
      if (activeTabIdRef.current === tabId) {
        setActiveTabId(remaining[Math.min(index, remaining.length - 1)].id);
      }
    },
    [createTerm, releaseTerm],
  );

  const reorderTabs = useCallback((from: number, to: number) => {
    const prev = tabsRef.current;
    const settingsOpen = settingsTabOpenRef.current;
    const settingsIndex = settingsTabIndexRef.current;
    const pinnedCount = prev.filter((t) => t.pinned).length;
    const result = applyStripReorder(
      prev.map((t) => t.id),
      settingsOpen,
      settingsIndex,
      from,
      to,
      pinnedCount,
    );
    if (!result) return;

    const byId = new Map(prev.map((t) => [t.id, t]));
    const nextTabs = result.tabIds
      .map((id) => byId.get(id))
      .filter((t): t is Tab => t !== undefined);
    setTabs(nextTabs);
    if (settingsOpen) setSettingsTabIndex(result.settingsIndex);
  }, []);

  /** Pin moves the tab to the leftmost free pin slot (after other pins); unpin leaves it. */
  const pinTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const index = prev.findIndex((t) => t.id === tabId);
      if (index < 0) return prev;
      const tab = prev[index];
      if (tab.pinned) {
        return prev.map((t) => (t.id === tabId ? { ...t, pinned: false } : t));
      }
      const rest = prev.filter((t) => t.id !== tabId);
      const pinned = rest.filter((t) => t.pinned);
      const unpinned = rest.filter((t) => !t.pinned);
      // New pin lands just after existing pins — the left-most free pin slot.
      return [...pinned, { ...tab, pinned: true }, ...unpinned];
    });
  }, []);

  const colorTab = useCallback((tabId: string, colorId: string | null) => {
    updateTab(tabId, (t) => ({ ...t, color: colorId }));
  }, [updateTab]);

  const iconTab = useCallback((tabId: string, iconId: string | null) => {
    updateTab(tabId, (t) => ({ ...t, icon: iconId }));
  }, [updateTab]);

  const closeOtherTabs = useCallback(
    async (keepId: string) => {
      const snapshot = tabsRef.current;
      const others = snapshot.filter((t) => t.id !== keepId);
      if (others.length === 0) return;

      const pinnedOthers = others.filter((t) => t.pinned);
      if (pinnedOthers.length > 0) {
        const n = pinnedOthers.length;
        const ok = await confirmCloseRunning({
          title: n === 1 ? "Close pinned tab?" : "Close pinned tabs?",
          message:
            n === 1
              ? `“${pinnedOthers[0].title}” is pinned. Close other tabs anyway?`
              : `${n} of those tabs are pinned. Close them anyway?`,
          confirmLabel: "Yes, close",
        });
        if (!ok) return;
      }

      // One prompt for the whole batch — "this tab" wording is wrong here because
      // the tabs being closed are the other ones, not the focused tab.
      const termsToCheck = others.flatMap((t) => leaves(t.root).map((n) => n.term));
      if (await terminals.anyHasRunningProcess(termsToCheck)) {
        const n = others.length;
        const ok = await confirmCloseRunning({
          title: n === 1 ? "Close other tab?" : "Close other tabs?",
          message:
            n === 1
              ? "That tab has a process running."
              : "Some of those tabs have processes running.",
          confirmLabel: n === 1 ? "Yes, close" : "Yes, close all",
          allowDontShowAgain: true,
        });
        if (!ok) return;
      }

      // Re-read after the dialog; keep only the tab that still exists.
      const latest = tabsRef.current;
      const keep = latest.find((t) => t.id === keepId);
      if (!keep) return;
      const stillOthers = latest.filter((t) => t.id !== keepId);
      for (const tab of stillOthers) {
        for (const node of leaves(tab.root)) releaseTerm(node.term);
      }
      setTabs([keep]);
      setActiveTabId(keep.id);
    },
    [releaseTerm],
  );

  const selectTab = useCallback((id: string) => {
    if (id !== activeTabIdRef.current) terminals.clearAllBlockSelections();
    const tab = tabsRef.current.find((candidate) => candidate.id === id);
    const term = tab ? findLeaf(tab.root, tab.activeLeaf)?.term : null;
    if (term) acknowledgeTerm(term);
    setSettingsActive(false);
    setActiveTabId(id);
  }, [acknowledgeTerm]);

  const openSettings = useCallback(() => {
    terminals.clearAllBlockSelections();
    // Warm Usage only when Settings is actually entered. The frontend cache
    // coalesces repeated clicks and keeps quick reopenings from touching disk
    // or provider endpoints again; leaving Settings open starts no polling.
    void prefetchUsage(loadUsageSettings().days, 60_000).catch(() => {
      // The Usage panel owns the visible retry/error state.
    });
    // Fresh open lands at the end of the strip; refocus keeps the last seat.
    if (!settingsTabOpenRef.current) {
      setSettingsTabIndex(tabsRef.current.length);
    }
    setSettingsTabOpen(true);
    setSettingsActive(true);
  }, []);

  const closeSettings = useCallback(() => {
    setSettingsTabOpen(false);
    setSettingsActive(false);
  }, []);

  const selectTabIndex = useCallback((index: number) => {
    const tab = tabsRef.current[index];
    if (tab) selectTab(tab.id);
  }, [selectTab]);

  const cycleTab = useCallback((step: 1 | -1) => {
    const prev = tabsRef.current;
    const index = prev.findIndex((t) => t.id === activeTabIdRef.current);
    if (index < 0) return;
    selectTab(prev[(index + step + prev.length) % prev.length].id);
  }, [selectTab]);

  // --------------------------------------------------------------- panes

  const splitPane = useCallback(
    (leafId: string, zone: "left" | "right" | "top" | "bottom") => {
      const tab = currentTab();
      if (!tab) return;
      const node = leaf(createTerm());
      updateTab(tab.id, (t) => ({
        ...t,
        root: insertBeside(t.root, leafId, node, zone),
        activeLeaf: node.id,
        zoomedLeaf: null,
      }));
    },
    [createTerm, currentTab, updateTab],
  );

  const closePane = useCallback(
    async (leafId: string) => {
      const tab = currentTab();
      if (!tab) return;
      const node = findLeaf(tab.root, leafId);
      if (!node) return;

      if (await terminals.hasRunningProcess(node.term)) {
        const agent = terminals.runningAgentLabel([node.term]);
        const ok = await confirmCloseRunning({
          title: "Close pane?",
          message: agent
            ? `${agent} is still open in this pane. Closing ends the session.`
            : "You have a process running in this pane.",
          confirmLabel: "Yes, close",
          allowDontShowAgain: true,
        });
        if (!ok) return;
      }

      // Re-read after the dialog — the layout may have changed while it was open.
      const tabNow = currentTab();
      if (!tabNow || tabNow.id !== tab.id) return;
      const nodeNow = findLeaf(tabNow.root, leafId);
      if (!nodeNow) return;
      const nextRoot = removeLeaf(tabNow.root, leafId);

      if (!nextRoot) {
        releaseTerm(nodeNow.term);
        // Term already checked above; skip a second busy prompt in closeTab.
        void closeTab(tabNow.id, [nodeNow.term]);
        return;
      }

      releaseTerm(nodeNow.term);
      const fallback = leaves(nextRoot)[0].id;
      updateTab(tabNow.id, (t) => ({
        ...t,
        root: nextRoot,
        activeLeaf: findLeaf(nextRoot, t.activeLeaf) ? t.activeLeaf : fallback,
        zoomedLeaf: t.zoomedLeaf === leafId ? null : t.zoomedLeaf,
      }));
    },
    [closeTab, currentTab, releaseTerm, updateTab],
  );

  const activatePane = useCallback(
    (leafId: string) => {
      const tab = currentTab();
      if (!tab) return;
      const node = findLeaf(tab.root, leafId);
      if (!node) return;
      acknowledgeTerm(node.term);
      if (tab.activeLeaf === leafId) return;
      // Leaving a pane (or tab leaf) drops its chunk selection — only one
      // terminal may own a selected block, and clicking another pane clears it.
      terminals.clearAllBlockSelections();
      updateTab(tab.id, (t) => ({ ...t, activeLeaf: leafId }));
    },
    [acknowledgeTerm, currentTab, updateTab],
  );

  const toggleZoom = useCallback(
    (leafId: string) => {
      const tab = currentTab();
      if (!tab) return;
      const node = findLeaf(tab.root, leafId);
      if (node) acknowledgeTerm(node.term);
      if (tab.activeLeaf !== leafId) terminals.clearAllBlockSelections();
      updateTab(tab.id, (t) => ({
        ...t,
        activeLeaf: leafId,
        zoomedLeaf: t.zoomedLeaf === leafId ? null : leafId,
      }));
    },
    [acknowledgeTerm, currentTab, updateTab],
  );

  const balancePanes = useCallback(() => {
    const tab = currentTab();
    if (!tab) return;
    updateTab(tab.id, (t) => ({ ...t, root: balance(t.root), zoomedLeaf: null }));
  }, [currentTab, updateTab]);

  const resizeSplitSizes = useCallback(
    (splitId: string, sizes: number[]) => {
      const tab = currentTab();
      if (!tab) return;
      updateTab(tab.id, (t) => ({ ...t, root: setSizes(t.root, splitId, sizes) }));
    },
    [currentTab, updateTab],
  );

  const focusDirection = useCallback(
    (direction: "left" | "right" | "up" | "down") => {
      const tab = currentTab();
      if (!tab) return;
      const panes = [...document.querySelectorAll<HTMLElement>("[data-pane-id]")];
      const current = panes.find((el) => el.dataset.paneId === tab.activeLeaf);
      if (!current) return;
      const from = current.getBoundingClientRect();
      const cx = from.left + from.width / 2;
      const cy = from.top + from.height / 2;

      let best: { id: string; score: number } | null = null;
      for (const el of panes) {
        const id = el.dataset.paneId;
        if (!id || id === tab.activeLeaf) continue;
        const rect = el.getBoundingClientRect();
        const dx = rect.left + rect.width / 2 - cx;
        const dy = rect.top + rect.height / 2 - cy;
        const forward =
          direction === "right" ? dx : direction === "left" ? -dx : direction === "down" ? dy : -dy;
        if (forward <= 1) continue;
        const off = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
        const score = forward + off * 3;
        if (!best || score < best.score) best = { id, score };
      }
      if (best) {
        activatePane(best.id);
      }
    },
    [activatePane, currentTab],
  );

  const cyclePane = useCallback(
    (step: 1 | -1) => {
      const tab = currentTab();
      if (!tab) return;
      const next = nextLeaf(tab.root, tab.activeLeaf, step);
      if (next && next !== tab.activeLeaf) activatePane(next);
    },
    [activatePane, currentTab],
  );

  // ---------------------------------------------------------- drag & drop

  const moveToTab = useCallback(
    (drag: DragState, targetTabId: string | null) => {
      const prev = tabsRef.current;
      const source = prev.find((t) => findLeaf(t.root, drag.leafId));
      if (!source || source.id === targetTabId) return;

      const moved = leaf(drag.term);
      const restRoot = removeLeaf(source.root, drag.leafId);

      let next = prev.map((t) => {
        if (t.id === source.id && restRoot) {
          const fallback = leaves(restRoot)[0].id;
          return {
            ...t,
            root: restRoot,
            activeLeaf: findLeaf(restRoot, t.activeLeaf) ? t.activeLeaf : fallback,
            zoomedLeaf: null,
          };
        }
        if (targetTabId && t.id === targetTabId) {
          return {
            ...t,
            root: insertBeside(t.root, t.activeLeaf, moved, "right"),
            activeLeaf: moved.id,
            zoomedLeaf: null,
          };
        }
        return t;
      });

      if (!restRoot) {
        const removedIndex = next.findIndex((t) => t.id === source.id);
        next = next.filter((t) => t.id !== source.id);
        if (settingsTabOpenRef.current && removedIndex >= 0) {
          setSettingsTabIndex((i) => adjustSettingsIndexOnClose(i, removedIndex));
        }
      }

      let focus = targetTabId;
      if (!targetTabId) {
        // The pane is still the same shell in the same folder — it just lives in
        // its own tab now, so the project comes with it.
        const previousCount = next.length;
        const created: Tab = {
          id: uid("tab"),
          title: source.project?.name ?? `Terminal ${next.length + 1}`,
          root: moved,
          activeLeaf: moved.id,
          zoomedLeaf: null,
          project: source.project,
        };
        next = [...next, created];
        focus = created.id;
        if (settingsTabOpenRef.current) {
          setSettingsTabIndex((i) => adjustSettingsIndexOnAppend(i, previousCount));
        }
      }

      setTabs(next);
      if (focus) setActiveTabId(focus);
    },
    [],
  );

  const handleDrop = useCallback(
    (drag: DragState) => {
      const target = drag.target;
      if (!target) return;

      if (target.kind === "newTab") {
        moveToTab(drag, null);
        return;
      }
      if (target.kind === "tab") {
        moveToTab(drag, target.tabId);
        return;
      }

      const tab = currentTab();
      if (!tab) return;
      if (target.paneId === drag.leafId) return;

      if (target.zone === "center") {
        updateTab(tab.id, (t) => ({
          ...t,
          root: swapLeaves(t.root, drag.leafId, target.paneId),
          activeLeaf: target.paneId,
        }));
        return;
      }

      const zone = target.zone;
      updateTab(tab.id, (t) => {
        const base = removeLeaf(t.root, drag.leafId);
        if (!base || !findLeaf(base, target.paneId)) return t;
        const moved = leaf(drag.term);
        return {
          ...t,
          root: insertBeside(base, target.paneId, moved, zone),
          activeLeaf: moved.id,
          zoomedLeaf: null,
        };
      });
    },
    [currentTab, moveToTab, updateTab],
  );

  const { drag, startDrag } = useDragPane(handleDrop);

  const onStartDrag = useCallback(
    (e: React.PointerEvent, node: LeafNode) => {
      const meta = terminals.getMeta(node.term);
      activatePane(node.id);
      startDrag(e, {
        leafId: node.id,
        term: node.term,
        label: meta?.title || meta?.shellLabel || "terminal",
      });
    },
    [activatePane, startDrag],
  );

  // ------------------------------------------------------------- project

  /**
   * Move a pane's shell into `path`. Panes with a command running are left
   * alone — the tab changed folders, that is no reason to interrupt a build.
   */
  const cdPane = useCallback(async (term: string, path: string) => {
    // A restored/background terminal may not be mounted yet. In that case,
    // change its spawn parameters instead of sending a command into nowhere.
    if (!terminals.getMeta(term)) {
      const recorded = spawnOpts.current.get(term);
      spawnOpts.current.set(term, {
        cwd: path,
        shell: recorded?.shell ?? shellRef.current,
      });
      return;
    }
    if (await terminals.hasRunningProcess(term)) return;
    // Blank panes keep the welcome duck (like a fresh split); used panes get a
    // normal `cd` in the grid. Quoting is shell-specific (see buildCdCommand).
    terminals.changeDirectory(term, path);
  }, []);

  /**
   * Point a tab at a folder. Opening a project is per-tab: each tab is its own
   * project, the way a Warp window holds several at once.
   */
  const applyProject = useCallback(
    async (path: string, options: { newTab?: boolean; tabId?: string } = {}) => {
      let info: ProjectInfo;
      try {
        info = await projectInfo(path);
      } catch (error) {
        console.error("failed to open project", error);
        setRecents((prev) => prev.filter((p) => p !== path));
        return;
      }

      lastProject.current = info.path;
      setRecents((prev) => pushRecent(prev, info.path));

      if (options.newTab) {
        // Spawning straight into the folder beats spawning then `cd`-ing.
        const term = createTerm({ cwd: info.path });
        const root = leaf(term);
        const tab: Tab = {
          id: uid("tab"),
          title: info.name,
          root,
          activeLeaf: root.id,
          zoomedLeaf: null,
          project: info,
        };
        setTabs([...tabsRef.current, tab]);
        setActiveTabId(tab.id);
        return;
      }

      const tab = options.tabId
        ? tabsRef.current.find((candidate) => candidate.id === options.tabId) ?? null
        : currentTab();
      if (!tab) return;
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tab.id ? { ...t, project: info, title: isAutoTitle(t) ? info.name : t.title } : t,
        ),
      );
      for (const node of leaves(tab.root)) void cdPane(node.term, info.path);
    },
    [cdPane, createTerm, currentTab],
  );

  /** Explorer / CLI asked for this folder — always as a dedicated project tab. */
  const handleLaunchIntent = useCallback(
    (intent: LaunchIntent) => {
      void applyProject(intent.path, { newTab: true });
    },
    [applyProject],
  );

  const openProject = useCallback(
    async (options: { newTab?: boolean; tabId?: string } = {}) => {
      const target = options.tabId
        ? tabsRef.current.find((tab) => tab.id === options.tabId) ?? null
        : currentTab();
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: options.newTab ? "Choose a folder for the new tab" : "Choose a folder for this tab",
        defaultPath: target?.project?.path ?? lastProject.current ?? undefined,
      });
      if (typeof selected !== "string") return;
      await applyProject(selected, options);
    },
    [applyProject, currentTab],
  );

  /**
   * Re-read the visible project. The branch it shows is whatever `.git/HEAD`
   * says, and the shell in the pane below can change that at any moment — so
   * this runs on a slow timer as well as on the events that obviously matter.
   */
  const refreshProject = useCallback(async (tabId?: string) => {
    const tab = tabId
      ? tabsRef.current.find((candidate) => candidate.id === tabId) ?? null
      : currentTab();
    const path = tab?.project?.path;
    if (!path) return;
    try {
      const info = await projectInfo(path);
      setTabs((prev) => {
        let changed = false;
        const next = prev.map((t) => {
          const current = t.project;
          if (current?.path !== path) return t;
          if (
            current.branch === info.branch &&
            current.name === info.name &&
            current.is_git === info.is_git
          ) {
            return t;
          }
          changed = true;
          return { ...t, project: info };
        });
        // Same array back on a no-op poll: React bails out, and so does the save.
        return changed ? next : prev;
      });
    } catch {
      // The folder can be renamed or unmounted underneath us; keep what we have.
    }
  }, [currentTab]);

  // ----------------------------------------------------------- lifecycle

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Drawing and spawning do not depend on shell discovery or restored
      // project metadata: null asks the backend for the same default shell.
      terminals.setFontSize(initial.fontSize);
      terminals.setHighlight(initial.highlight);
      terminals.setAgentUi(initial.customAgentUi);
      terminals.setInputMode(initial.inputMode);
      preloadCompletionSound();
      if (!cancelled) setBooted(true);

      try {
        if (!TAURI_RUNTIME) throw new Error("browser preview");
        const list = await listShells();
        if (!cancelled) {
          setShells(list);
          if (!shellRef.current && list.length > 0) {
            setShell(list[0].id);
            shellRef.current = list[0].id;
          }
        }
      } catch (error) {
        if (TAURI_RUNTIME) console.error("failed to list shells", error);
      }

      // Restored tabs carry only a path; fill in the real name and branch.
      const paths = [...new Set(initial.tabs.map((t) => t.project?.path).filter(Boolean))] as string[];
      void Promise.all(
        paths.map(async (path) => {
          try {
            const info = await projectInfo(path);
            if (!cancelled) {
              setTabs((prev) => prev.map((t) => (t.project?.path === path ? { ...t, project: info } : t)));
            }
          } catch {
            // Folder is gone — the tab keeps the name, and opening a new one is
            // the user's move to make.
            if (!cancelled) setRecents((prev) => prev.filter((p) => p !== path));
          }
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [initial]);

  // The window title follows the tab you are looking at.
  useEffect(() => {
    if (!TAURI_RUNTIME) return;
    void getCurrentWindow().setTitle(project ? `Duckweed — ${project.name}` : "Duckweed");
  }, [project]);

  // Watch only the visible project. Shell edits, checkouts and external tools
  // arrive as one debounced event rather than two permanent polling loops.
  useEffect(() => {
    if (!TAURI_RUNTIME) return;
    void watchProject(project?.path ?? null);
  }, [project?.path]);

  // Keep the branch chip honest on tab switch, focus and watcher notifications.
  useEffect(() => {
    void refreshProject();
    const onFocus = () => void refreshProject();
    window.addEventListener("focus", onFocus);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (TAURI_RUNTIME) {
      void listen<string>("project:changed", (event) => {
        if (event.payload === currentTab()?.project?.path) void refreshProject();
      }).then((off) => {
        if (disposed) off();
        else unlisten = off;
      });
    }
    return () => {
      disposed = true;
      window.removeEventListener("focus", onFocus);
      unlisten?.();
    };
  }, [activeTabId, currentTab, refreshProject]);

  // The native window starts hidden so users never see a half-painted webview.
  useEffect(() => {
    if (!booted || !TAURI_RUNTIME) return;
    const frame = requestAnimationFrame(() => void frontendReady());
    return () => cancelAnimationFrame(frame);
  }, [booted]);

  // Cold-start folder from Explorer, plus live handoffs while already running.
  useEffect(() => {
    if (!booted || !TAURI_RUNTIME) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void takeLaunchIntent()
      .then((intent) => {
        if (!disposed && intent?.path) handleLaunchIntent(intent);
      })
      .catch(() => {
        /* browser preview / older builds */
      });

    void listen<LaunchIntent>("launch-intent", (event) => {
      if (event.payload?.path) handleLaunchIntent(event.payload);
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [booted, handleLaunchIntent]);

  // Windows-only: folder context menu verbs (tab on by default, window opt-in).
  useEffect(() => {
    if (!TAURI_RUNTIME) return;
    void shellIntegrationStatus()
      .then((status) => {
        if (status && typeof status.tab === "boolean" && typeof status.window === "boolean") {
          setExplorerIntegration(status);
        } else {
          setExplorerIntegration(null);
        }
      })
      .catch(() => setExplorerIntegration(null));
  }, []);

  // A tab with no repo has nothing to review, and a panel that reappeared on
  // the way back would be showing another project's diff.
  useEffect(() => {
    if (!project?.is_git) setChangesOpen(false);
  }, [project?.is_git]);

  // Settings toggle -> module flag used by confirmCloseRunning().
  useEffect(() => {
    setConfirmCloseRunningEnabled(confirmCloseRunningPref);
  }, [confirmCloseRunningPref]);

  // Dialog "Don't show this again" flips the module flag; mirror into React so
  // Settings and localStorage stay honest.
  useEffect(() => {
    return subscribeConfirmClosePref(() => {
      setConfirmCloseRunningPref(isConfirmCloseRunningEnabled());
    });
  }, []);

  // Persist the arrangement (never the processes). Debounced because dragging a
  // divider produces a state update per pointer move.
  useEffect(() => {
    if (!booted) return;
    const id = window.setTimeout(
      () =>
        save({
          project: lastProject.current,
          recents,
          fontSize,
          shell,
          highlight,
          completionHighlights,
          completionSoundEnabled,
          customAgentUi,
          inputMode,
          confirmCloseRunning: confirmCloseRunningPref,
          toolsOpen,
          toolsWidth,
          tabs,
          activeTabId,
        }),
      400,
    );
    return () => window.clearTimeout(id);
  }, [
    booted,
    project,
    recents,
    fontSize,
    shell,
    highlight,
    completionHighlights,
    completionSoundEnabled,
    customAgentUi,
    inputMode,
    confirmCloseRunningPref,
    toolsOpen,
    toolsWidth,
    tabs,
    activeTabId,
  ]);

  // The grid just lost (or got back) horizontal room; the per-pane observers see
  // it, but re-measuring on the next frame keeps the reflow to a single pass.
  useEffect(() => {
    const frame = requestAnimationFrame(() => terminals.refitAll());
    return () => cancelAnimationFrame(frame);
  }, [toolsOpen, toolsWidth]);

  // Keep the OS focus on the terminal the UI considers active.
  const focusKey = activeTab ? `${activeTab.id}:${activeTab.activeLeaf}` : "";
  useEffect(() => {
    const tab = currentTab();
    if (!tab) return;
    const node = findLeaf(tab.root, tab.activeLeaf);
    if (!node) return;
    const id = window.setTimeout(() => terminals.focus(node.term), 0);
    return () => window.clearTimeout(id);
  }, [focusKey, currentTab]);

  useEffect(() => {
    const cleanup = () => terminals.disposeAll();
    window.addEventListener("beforeunload", cleanup);
    return () => window.removeEventListener("beforeunload", cleanup);
  }, []);

  // Warn before quitting if any terminal still has a command running.
  useEffect(() => {
    if (!TAURI_RUNTIME) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        const ids = terminals.allSessionIds();
        if (!(await terminals.anyHasRunningProcess(ids))) return;
        const agent = terminals.runningAgentLabel(ids);
        const ok = await confirmCloseRunning({
          title: "Quit Duckweed?",
          message: agent
            ? `${agent} is still open in a terminal. Quitting ends the session.`
            : "You have processes running in open terminals.",
          confirmLabel: "Yes, quit",
          allowDontShowAgain: true,
        });
        if (!ok) event.preventDefault();
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Each pane has a ResizeObserver, but maximize/fullscreen/DPI changes can land
  // as a single reflow that those observers coalesce away — re-measure everything
  // on the window resize as well, on the next frame so the new layout is settled.
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => terminals.refitAll());
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const applyFontSize = useCallback((size: number) => {
    terminals.setFontSize(size);
    setFontSize(terminals.getFontSize());
  }, []);

  const toggleHighlight = useCallback(() => {
    const next = !terminals.getHighlight();
    terminals.setHighlight(next);
    setHighlight(next);
  }, []);

  const toggleCompletionHighlights = useCallback(() => {
    setCompletionHighlights((prev) => !prev);
  }, []);

  useEffect(() => {
    if (completionHighlights) return;
    for (const timer of completionFlashTimers.current.values()) {
      window.clearTimeout(timer);
    }
    completionFlashTimers.current.clear();
    setCompletionFlashes((previous) => (previous.size === 0 ? previous : new Map()));
  }, [completionHighlights]);

  useEffect(
    () => () => {
      for (const timer of completionFlashTimers.current.values()) {
        window.clearTimeout(timer);
      }
      completionFlashTimers.current.clear();
    },
    [],
  );

  const toggleCompletionSound = useCallback(() => {
    setCompletionSoundEnabled((prev) => !prev);
  }, []);

  const toggleCustomAgentUi = useCallback(() => {
    setCustomAgentUi((prev) => {
      const next = !prev;
      terminals.setAgentUi(next);
      return next;
    });
  }, []);

  const toggleInputMode = useCallback(() => {
    const next = terminals.getInputMode() === "editor" ? "raw" : "editor";
    terminals.setInputMode(next);
    setInputMode(next);
  }, []);

  // --------------------------------------------------------- tools panel

  /** Hand a path from the explorer to the prompt of the focused pane. */
  const insertPath = useCallback(
    (path: string) => {
      const tab = currentTab();
      const node = tab ? findLeaf(tab.root, tab.activeLeaf) : null;
      if (!node) return;
      terminals.paste(node.term, /\s/.test(path) ? `"${path}"` : path);
      terminals.focus(node.term);
    },
    [currentTab],
  );

  /** `cd` the focused pane, the same way opening a project moves its panes. */
  const cdActivePane = useCallback(
    (path: string) => {
      const tab = currentTab();
      const node = tab ? findLeaf(tab.root, tab.activeLeaf) : null;
      if (node) void cdPane(node.term, path);
    },
    [cdPane, currentTab],
  );

  /** Open a path in the popup editor; confirm first if another dirty buffer is open. */
  const openExplorerFile = useCallback(
    async (path: string) => {
      if (openFile === path) return;
      if (openFile && editorDirtyRef.current) {
        const ok = await confirmCloseRunning({
          title: "Unsaved changes",
          message: "The open file has unsaved edits. Discard them and open another?",
          confirmLabel: "Discard",
        });
        if (!ok) return;
      }
      setOpenFile(path);
    },
    [openFile],
  );

  // ----------------------------------------------------------- shortcuts

  const actions = {
    splitPane,
    closePane,
    toggleZoom,
    balancePanes,
    newTab,
    closeTab,
    cycleTab,
    selectTabIndex,
    cyclePane,
    focusDirection,
    openProject,
    applyFontSize,
    toggleHighlight,
    currentTab,
    setPaletteOpen,
    setChangesOpen,
    setToolsOpen,
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const a = actionsRef.current;
      const tab = a.currentTab();
      const activeLeaf = tab?.activeLeaf ?? null;
      const activeTerm = tab && activeLeaf ? (findLeaf(tab.root, activeLeaf)?.term ?? null) : null;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      const take = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (e.key === "F11") {
        void toggleFullscreen();
        return take();
      }

      // Zoom and tab selection go by physical key so they survive non-US layouts.
      if (ctrl) {
        if (e.code === "Equal" || e.code === "NumpadAdd") {
          a.applyFontSize(terminals.getFontSize() + 1);
          return take();
        }
        if (e.code === "Minus" || e.code === "NumpadSubtract") {
          a.applyFontSize(terminals.getFontSize() - 1);
          return take();
        }
        if (e.code === "Digit0" || e.code === "Numpad0") {
          a.applyFontSize(DEFAULT_FONT_SIZE);
          return take();
        }
        if (!e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
          a.selectTabIndex(Number(e.code.slice(5)) - 1);
          return take();
        }
        if (e.shiftKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
          a.cyclePane(e.code === "BracketRight" ? 1 : -1);
          return take();
        }
        if (e.key === "Tab") {
          a.cycleTab(e.shiftKey ? -1 : 1);
          return take();
        }
      }

      // Plain Ctrl+V. Left alone, xterm swallows it: it turns the key into a
      // literal ^V for the shell and cancels the event, so the webview's own
      // paste never runs. That is what breaks dictation tools like OpenFlow,
      // which put the transcription on the clipboard and synthesise a Ctrl+V
      // into whatever window is focused — the keystroke lands, nothing appears.
      // So keep the key away from xterm, but do not call preventDefault: the
      // native paste is exactly what we want. It is also the only way to read
      // the clipboard synchronously — those tools put the user's previous
      // clipboard back a couple of hundred milliseconds later, which an async
      // navigator.clipboard read can easily lose the race to.
      // Plain Ctrl+V. Prefer the command editor (or raw grid) of the active pane.
      // Left alone, xterm swallows Ctrl+V into a literal ^V for the shell.
      if (ctrl && !e.shiftKey && !e.altKey && key === "v" && !isTextField(e.target)) {
        if (activeTerm) terminals.focus(activeTerm);
        e.stopPropagation();
        return;
      }

      // Plain Ctrl+C with a grid selection: copy, never interrupt. Without this,
      // focus-on-xterm after a drag turns Ctrl+C into \x03 and PowerShell paints
      // a stack of `PS …> ^C` lines under the blocks.
      if (ctrl && !e.shiftKey && !e.altKey && key === "c" && !isTextField(e.target)) {
        if (activeTerm) {
          const text = terminals.selection(activeTerm);
          if (text) {
            void navigator.clipboard.writeText(text);
            return take();
          }
        }
      }

      if (ctrl && e.shiftKey) {
        switch (key) {
          case "d":
            if (activeLeaf) a.splitPane(activeLeaf, "right");
            return take();
          case "e":
            if (activeLeaf) a.splitPane(activeLeaf, "bottom");
            return take();
          case "w":
            if (activeLeaf) void a.closePane(activeLeaf);
            return take();
          case "z":
            if (activeLeaf) a.toggleZoom(activeLeaf);
            return take();
          case "b":
            a.balancePanes();
            return take();
          case "t":
            // Empty tabs without a folder can't run commands — don't spawn more.
            if (tab?.project) a.newTab(null);
            return take();
          case "q":
            if (tab) void a.closeTab(tab.id);
            return take();
          case "o":
            void a.openProject();
            return take();
          case "p":
            a.setPaletteOpen(true);
            return take();
          case "g":
            // Only a repo has changes to review; in anything else the key does
            // nothing rather than opening an empty panel.
            if (tab?.project?.is_git) a.setChangesOpen((open) => !open);
            return take();
          case "x":
            a.setToolsOpen((open) => !open);
            return take();
          case "f":
            if (activeLeaf) bus.emit("pane:search", { leafId: activeLeaf });
            return take();
          case "k":
            if (activeTerm) terminals.clear(activeTerm);
            return take();
          case "h":
            a.toggleHighlight();
            return take();
          case "c": {
            if (!activeTerm) return;
            const text = terminals.selection(activeTerm);
            if (text) void navigator.clipboard.writeText(text);
            return take();
          }
          case "v": {
            if (!activeTerm) return;
            void navigator.clipboard.readText().then((text) => {
              if (text) terminals.paste(activeTerm, text);
            });
            return take();
          }
          default:
            break;
        }
      }

      if (e.altKey && !ctrl) {
        const map: Record<string, "left" | "right" | "up" | "down"> = {
          arrowleft: "left",
          arrowright: "right",
          arrowup: "up",
          arrowdown: "down",
        };
        const direction = map[key];
        if (direction) {
          a.focusDirection(direction);
          return take();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // A paste nobody claimed — the keystroke arrived while the focus sat on the
  // tab strip, a pane header or the body, so it never reached a terminal. xterm
  // stops propagation on the pastes it does handle, so anything that gets this
  // far belongs to the active terminal by default.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTextField(e.target)) return;
      const text = e.clipboardData?.getData("text/plain");
      if (!text) return;
      const tab = actionsRef.current.currentTab();
      const node = tab ? findLeaf(tab.root, tab.activeLeaf) : null;
      if (!node) return;
      e.preventDefault();
      terminals.paste(node.term, text);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // ------------------------------------------------------------- palette

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const tab = tabs.find((t) => t.id === activeTabId);
    const activeLeaf = tab?.activeLeaf ?? null;
    const actions: PaletteAction[] = [
      {
        id: "project.open",
        group: "Project",
        title: "Open project folder in this tab…",
        subtitle: "Each tab has its own project",
        hint: "Ctrl+Shift+O",
        run: () => void openProject(),
      },
      {
        id: "project.open.tab",
        group: "Project",
        title: "Open project folder in a new tab…",
        run: () => void openProject({ newTab: true }),
      },
      ...(project?.is_git
        ? [
            {
              id: "git.changes",
              group: "Git",
              title: "Review uncommitted changes",
              subtitle: changes.stats
                ? `${changes.stats.files} file${changes.stats.files === 1 ? "" : "s"} · +${changes.stats.insertions} −${changes.stats.deletions}`
                : project.path,
              hint: "Ctrl+Shift+G",
              run: () => setChangesOpen(true),
            },
          ]
        : []),
      ...(project
        ? [{ id: "tab.new", group: "Tab", title: "New tab", hint: "Ctrl+Shift+T", run: () => newTab(null) }]
        : []),
      {
        id: "tab.close",
        group: "Tab",
        title: "Close tab",
        hint: "Ctrl+Shift+Q",
        run: () => {
          if (tab) void closeTab(tab.id);
        },
      },
      {
        id: "pane.right",
        group: "Pane",
        title: "Split right",
        hint: "Ctrl+Shift+D",
        run: () => activeLeaf && splitPane(activeLeaf, "right"),
      },
      {
        id: "pane.down",
        group: "Pane",
        title: "Split down",
        hint: "Ctrl+Shift+E",
        run: () => activeLeaf && splitPane(activeLeaf, "bottom"),
      },
      {
        id: "pane.left",
        group: "Pane",
        title: "Split left",
        run: () => activeLeaf && splitPane(activeLeaf, "left"),
      },
      {
        id: "pane.up",
        group: "Pane",
        title: "Split up",
        run: () => activeLeaf && splitPane(activeLeaf, "top"),
      },
      {
        id: "pane.zoom",
        group: "Pane",
        title: "Toggle pane zoom",
        hint: "Ctrl+Shift+Z",
        run: () => activeLeaf && toggleZoom(activeLeaf),
      },
      {
        id: "pane.balance",
        group: "Pane",
        title: "Even out panes",
        hint: "Ctrl+Shift+B",
        run: balancePanes,
      },
      {
        id: "pane.close",
        group: "Pane",
        title: "Close pane",
        hint: "Ctrl+Shift+W",
        run: () => {
          if (activeLeaf) void closePane(activeLeaf);
        },
      },
      {
        id: "pane.search",
        group: "Pane",
        title: "Find in terminal",
        hint: "Ctrl+Shift+F",
        run: () => activeLeaf && bus.emit("pane:search", { leafId: activeLeaf }),
      },
      {
        id: "view.tools",
        group: "View",
        title: toolsOpen ? "Hide the tools panel" : "Show the tools panel",
        subtitle: "Project explorer beside the grid",
        hint: "Ctrl+Shift+X",
        run: () => setToolsOpen((open) => !open),
      },
      {
        id: "view.fullscreen",
        group: "View",
        title: "Toggle fullscreen",
        hint: "F11",
        run: () => void toggleFullscreen(),
      },
      {
        id: "view.font.up",
        group: "View",
        title: "Increase font size",
        hint: "Ctrl+=",
        run: () => applyFontSize(terminals.getFontSize() + 1),
      },
      {
        id: "view.font.down",
        group: "View",
        title: "Decrease font size",
        hint: "Ctrl+-",
        run: () => applyFontSize(terminals.getFontSize() - 1),
      },
      {
        id: "view.font.reset",
        group: "View",
        title: "Reset font size",
        hint: "Ctrl+0",
        run: () => applyFontSize(DEFAULT_FONT_SIZE),
      },
      {
        id: "app.update",
        group: "App",
        title: "Check for updates",
        subtitle: `${updater.channel === "testing" ? "Beta" : "Stable"} channel${updater.version ? ` · v${updater.version}` : ""}`,
        run: updater.check,
      },
      {
        id: "view.inputmode",
        group: "View",
        title:
          inputMode === "editor"
            ? "Use the raw terminal for input"
            : "Use the command editor for input",
        subtitle:
          inputMode === "editor"
            ? "Type straight into the grid, like a conventional terminal"
            : "Compose commands in a text field below the grid (Warp-style)",
        run: toggleInputMode,
      },
      {
        id: "view.highlight",
        group: "View",
        title: highlight ? "Turn off syntax highlighting" : "Turn on syntax highlighting",
        subtitle: "Colours output that arrives with no colour of its own",
        hint: "Ctrl+Shift+H",
        run: toggleHighlight,
      },
      {
        id: "view.agentui",
        group: "View",
        title: customAgentUi ? "Turn off Custom Agent UI" : "Turn on Custom Agent UI",
        subtitle: "Draw Duckweed's own interface over Claude, Codex, Cursor, Grok, and OpenCode",
        run: toggleCustomAgentUi,
      },
    ];

    for (const info of shells) {
      actions.push({
        id: `shell.default.${info.id}`,
        group: "Shell",
        title: `Use ${info.label} for new terminals`,
        subtitle: info.program,
        run: () => {
          setShell(info.id);
          shellRef.current = info.id;
        },
      });
      if (project) {
        actions.push({
          id: `shell.tab.${info.id}`,
          group: "Shell",
          title: `New tab with ${info.label}`,
          run: () => newTab(info.id),
        });
      }
    }

    for (const path of recents) {
      actions.push({
        id: `recent.${path}`,
        group: "Recent",
        title: basename(path),
        subtitle: path,
        run: () => void applyProject(path),
      });
      actions.push({
        id: `recent.tab.${path}`,
        group: "Recent",
        title: `${basename(path)} in a new tab`,
        subtitle: path,
        run: () => void applyProject(path, { newTab: true }),
      });
    }

    tabs.forEach((t, i) => {
      actions.push({
        id: `goto.tab.${t.id}`,
        group: "Go to",
        title: `Tab: ${t.title}`,
        hint: i < 9 ? `Ctrl+${i + 1}` : undefined,
        run: () => selectTab(t.id),
      });
    });

    if (tab) {
      for (const node of leaves(tab.root)) {
        const meta = terminals.getMeta(node.term);
        actions.push({
          id: `goto.pane.${node.id}`,
          group: "Go to",
          title: `Pane: ${meta?.title || meta?.shellLabel || "terminal"}`,
          subtitle: meta?.cwd ?? undefined,
          run: () => activatePane(node.id),
        });
      }
    }

    return actions;
  }, [
    activatePane,
    activeTabId,
    applyFontSize,
    applyProject,
    balancePanes,
    changes.stats,
    closePane,
    closeTab,
    customAgentUi,
    highlight,
    inputMode,
    newTab,
    openProject,
    recents,
    shells,
    splitPane,
    tabs,
    toggleCustomAgentUi,
    toggleHighlight,
    toggleInputMode,
    toggleZoom,
    toolsOpen,
    updater.channel,
    updater.check,
    updater.version,
  ]);

  // --------------------------------------------------------------- render

  const paneCounts = useMemo(
    () => Object.fromEntries(tabs.map((t) => [t.id, leaves(t.root).length])),
    [tabs],
  );
  const unreadCounts = useMemo(
    () =>
      Object.fromEntries(
        tabs.map((tab) => [
          tab.id,
          leaves(tab.root).filter((node) => unreadTermIds.has(node.term)).length,
        ]),
      ),
    [tabs, unreadTermIds],
  );

  const browseActiveProject = useCallback(() => {
    const tab = currentTab();
    if (tab) void openProject({ tabId: tab.id });
  }, [currentTab, openProject]);
  const pickActiveProject = useCallback(
    (path: string) => {
      const tab = currentTab();
      if (tab) void applyProject(path, { tabId: tab.id });
    },
    [applyProject, currentTab],
  );
  const splitAt = useCallback(
    (leafId: string, zone: "right" | "bottom") => splitPane(leafId, zone),
    [splitPane],
  );
  const closePaneById = useCallback((id: string) => void closePane(id), [closePane]);

  const shared = useMemo<PaneTreeShared>(
    () => ({
      activeLeaf: activeTab?.activeLeaf ?? "",
      drag,
      spawnFor,
      highlight,
      // Tracking still runs; the setting only hides the rose chrome.
      unreadTerms: completionHighlights ? unreadTermIds : NO_UNREAD_TERMS,
      completionFlashes: completionHighlights ? completionFlashes : NO_COMPLETION_FLASHES,
      project,
      recents,
      onBrowseProject: browseActiveProject,
      onPickProject: pickActiveProject,
      zoomedLeaf: activeTab?.zoomedLeaf ?? null,
      onActivate: activatePane,
      onSplit: splitAt,
      onClose: closePaneById,
      onToggleZoom: toggleZoom,
      onStartDrag,
      onResize: resizeSplitSizes,
    }),
    [
      activeTab?.activeLeaf,
      activeTab?.zoomedLeaf,
      activatePane,
      browseActiveProject,
      closePaneById,
      completionFlashes,
      completionHighlights,
      drag,
      highlight,
      onStartDrag,
      pickActiveProject,
      project,
      recents,
      resizeSplitSizes,
      spawnFor,
      splitAt,
      toggleZoom,
      unreadTermIds,
    ],
  );

  const tabProjects = useMemo(
    () => ({
      recents,
      setFor: (tabId: string, path: string) => void applyProject(path, { tabId }),
      browseFor: (tabId: string) => void openProject({ tabId }),
    }),
    [applyProject, openProject, recents],
  );

  const zoomedNode =
    activeTab?.zoomedLeaf ? findLeaf(activeTab.root, activeTab.zoomedLeaf) : null;
  const activeTerm = activeTab ? (findLeaf(activeTab.root, activeTab.activeLeaf)?.term ?? null) : null;

  return (
    <div className="app">
      <TitleBar
        settingsActive={settingsActive}
        onOpenSettings={openSettings}
        toolsOpen={toolsOpen}
        onToggleTools={() => setToolsOpen((open) => !open)}
      >
        <TabStrip
          tabs={tabs}
          activeTabId={activeTabId}
          paneCounts={paneCounts}
          unreadCounts={unreadCounts}
          completionHighlights={completionHighlights}
          drag={drag}
          projects={tabProjects}
          allowNewTab={!!project}
          onSelect={selectTab}
          onClose={(id) => void closeTab(id)}
          onCloseOthers={(id) => void closeOtherTabs(id)}
          onNew={newTab}
          onReorder={reorderTabs}
          onRename={(id, title) => updateTab(id, (t) => ({ ...t, title }))}
          onPin={pinTab}
          onColor={colorTab}
          onIcon={iconTab}
          settingsOpen={settingsTabOpen}
          settingsActive={settingsActive}
          settingsIndex={settingsTabIndex}
          onSelectSettings={openSettings}
          onCloseSettings={closeSettings}
        />
      </TitleBar>

      {/* The dock shares the row with the grid rather than covering it, so a
          folder can be read while a command is still running. */}
      <div className="workbench">
        {toolsOpen && !settingsActive && (
          <ToolsPanel
            project={project}
            width={toolsWidth}
            onWidth={setToolsWidth}
            onClose={() => setToolsOpen(false)}
            onInsertPath={insertPath}
            onOpenFolder={cdActivePane}
            onBrowseProject={browseActiveProject}
            onOpenFile={(path) => void openExplorerFile(path)}
          />
        )}

        <main className="workspace">
          {/* Keep Settings mounted while its tab exists so scroll position is
              preserved natively when switching to a terminal tab and back. */}
          {settingsTabOpen && (
            <div
              className={`settings-host${settingsActive ? " is-active" : ""}`}
              aria-hidden={!settingsActive}
            >
              <SettingsMenu
                active={settingsActive}
                fontSize={fontSize}
                inputMode={inputMode}
                highlight={highlight}
                completionHighlights={completionHighlights}
                completionSoundEnabled={completionSoundEnabled}
                customAgentUi={customAgentUi}
                confirmCloseRunning={confirmCloseRunningPref}
                explorerIntegration={explorerIntegration}
                shell={shell}
                shells={shells}
                updateLabel={`${updater.channel === "testing" ? "Beta" : "Stable"}${updater.version ? ` · v${updater.version}` : ""}`}
                onFontSize={applyFontSize}
                onToggleInputMode={toggleInputMode}
                onToggleHighlight={toggleHighlight}
                onToggleCompletionHighlights={toggleCompletionHighlights}
                onToggleCompletionSound={toggleCompletionSound}
                onToggleCustomAgentUi={toggleCustomAgentUi}
                onToggleConfirmCloseRunning={() =>
                  setConfirmCloseRunningPref((prev) => !prev)
                }
                onToggleExplorerTab={() => {
                  if (explorerIntegration === null) return;
                  void shellIntegrationSet("tab", !explorerIntegration.tab)
                    .then((status) => setExplorerIntegration(status))
                    .catch((error) => console.error("shell integration", error));
                }}
                onToggleExplorerWindow={() => {
                  if (explorerIntegration === null) return;
                  void shellIntegrationSet("window", !explorerIntegration.window)
                    .then((status) => setExplorerIntegration(status))
                    .catch((error) => console.error("shell integration", error));
                }}
                onResetSuggestions={() =>
                  confirmCloseRunning({
                    title: "Reset suggestions?",
                    message:
                      "Duckweed will forget every command it learned. Ghost suggestions start fresh. This can't be undone.",
                    confirmLabel: "Reset",
                  }).then((ok) => {
                    if (ok) commandHistory.clear();
                    return ok;
                  })
                }
                onShell={(shellId) => {
                  setShell(shellId);
                  shellRef.current = shellId;
                }}
                onCheckUpdates={updater.check}
              />
            </div>
          )}
          {!settingsActive &&
            (!booted ? (
              <div className="booting">starting shell…</div>
            ) : zoomedNode && activeTab ? (
              <PaneTree node={zoomedNode} shared={shared} />
            ) : activeTab ? (
              <PaneTree node={activeTab.root} shared={shared} />
            ) : null)}
        </main>
      </div>

      <StatusBar
        project={project}
        paneCount={activeTab ? leaves(activeTab.root).length : 0}
        tabCount={tabs.length}
        activeTerm={activeTerm}
        fontSize={fontSize}
        onFontSize={applyFontSize}
        updater={updater}
        changes={changes.stats}
        onOpenChanges={() => setChangesOpen(true)}
        onProjectRefresh={() => void refreshProject(activeTab?.id)}
      />

      {drag && (
        <div className="drag-ghost">
          <span className="pane-grip" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {drag.label}
        </div>
      )}

      {paletteOpen && <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />}

      {changesOpen && project?.is_git && (
        <ChangesPanel
          project={project}
          onClose={() => {
            setChangesOpen(false);
            // Whatever happened in there — a commit, a discard — the chip is
            // one poll behind until it re-reads.
            changes.refresh();
          }}
        />
      )}

      {openFile && (
        <FileEditor
          key={openFile}
          path={openFile}
          onClose={() => setOpenFile(null)}
          onDirtyChange={(dirty) => {
            editorDirtyRef.current = dirty;
          }}
        />
      )}

      {updater.dialogOpen && <UpdateDialog updater={updater} />}
      <ConfirmCloseDialog />
    </div>
  );
}
