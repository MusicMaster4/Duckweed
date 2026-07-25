import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { PaneTree, type PaneTreeShared } from "./components/PaneTree";
import { StatusBar } from "./components/StatusBar";
import { TabStrip } from "./components/TabStrip";
import { TitleBar } from "./components/TitleBar";
import { useDragPane, type DragState } from "./hooks/useDragPane";
import * as bus from "./lib/bus";
import { listShells, projectInfo } from "./lib/ipc";
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
import { load, pushRecent, rehydrate, save } from "./lib/persist";
import * as terminals from "./lib/terminals";
import type { LeafNode, ProjectInfo, ShellInfo, Tab } from "./lib/types";

interface SpawnOpts {
  cwd: string | null;
  shell: string | null;
}

const DEFAULT_FONT_SIZE = 13.5;

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
      };
    });
    const index = Math.min(Math.max(0, saved.activeTabIndex), tabs.length - 1);
    return {
      tabs,
      activeTabId: tabs[index].id,
      projectPath: saved.project,
      recents: saved.recents,
      fontSize: saved.fontSize,
      shell: saved.shell,
      highlight: saved.highlight,
    };
  }
  const term = terminals.newTermId();
  const root = leaf(term);
  const tab: Tab = { id: uid("tab"), title: "Terminal 1", root, activeLeaf: root.id, zoomedLeaf: null };
  return {
    tabs: [tab],
    activeTabId: tab.id,
    projectPath: null as string | null,
    recents: [] as string[],
    fontSize: DEFAULT_FONT_SIZE,
    shell: null as string | null,
    highlight: true,
  };
}

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
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [recents, setRecents] = useState<string[]>(initial.recents);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [shell, setShell] = useState<string | null>(initial.shell);
  const [fontSize, setFontSize] = useState(initial.fontSize);
  const [highlight, setHighlight] = useState(initial.highlight);
  const [booted, setBooted] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [recentsMenu, setRecentsMenu] = useState<{ x: number; y: number } | null>(null);

  // Handlers read state through refs so keyboard shortcuts and pointer drags
  // never act on a stale snapshot.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const projectRef = useRef(project);
  projectRef.current = project;
  const shellRef = useRef(shell);
  shellRef.current = shell;

  /** Spawn parameters for terminals that have not been created yet. */
  const spawnOpts = useRef(new Map<string, SpawnOpts>());

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  const currentTab = useCallback(
    () => tabsRef.current.find((t) => t.id === activeTabIdRef.current) ?? tabsRef.current[0] ?? null,
    [],
  );

  const updateTab = useCallback((tabId: string, fn: (tab: Tab) => Tab) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? fn(t) : t)));
  }, []);

  /** cwd a new pane should start in: follow the focused shell, then the project. */
  const inheritCwd = useCallback((): string | null => {
    const tab = currentTab();
    if (tab) {
      const active = findLeaf(tab.root, tab.activeLeaf);
      const meta = active ? terminals.getMeta(active.term) : null;
      if (meta?.cwd) return meta.cwd;
    }
    return projectRef.current?.path ?? null;
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

  const spawnFor = useCallback(
    (term: string): SpawnOpts =>
      spawnOpts.current.get(term) ?? { cwd: projectRef.current?.path ?? null, shell: shellRef.current },
    [],
  );

  const releaseTerm = useCallback((term: string) => {
    terminals.dispose(term);
    spawnOpts.current.delete(term);
  }, []);

  // ---------------------------------------------------------------- tabs

  const newTab = useCallback(
    (shellId?: string | null) => {
      const term = createTerm({ cwd: projectRef.current?.path ?? null, shell: shellId ?? shellRef.current });
      const root = leaf(term);
      const title = projectRef.current
        ? projectRef.current.name
        : `Terminal ${tabsRef.current.length + 1}`;
      const tab: Tab = { id: uid("tab"), title, root, activeLeaf: root.id, zoomedLeaf: null };
      setTabs([...tabsRef.current, tab]);
      setActiveTabId(tab.id);
    },
    [createTerm],
  );

  const closeTab = useCallback(
    (tabId: string, skipTerms: string[] = []) => {
      const prev = tabsRef.current;
      const tab = prev.find((t) => t.id === tabId);
      if (!tab) return;
      for (const node of leaves(tab.root)) {
        if (!skipTerms.includes(node.term)) releaseTerm(node.term);
      }
      const index = prev.findIndex((t) => t.id === tabId);
      const remaining = prev.filter((t) => t.id !== tabId);

      if (remaining.length === 0) {
        const term = createTerm({ cwd: projectRef.current?.path ?? null });
        const root = leaf(term);
        const fresh: Tab = {
          id: uid("tab"),
          title: projectRef.current?.name ?? "Terminal 1",
          root,
          activeLeaf: root.id,
          zoomedLeaf: null,
        };
        setTabs([fresh]);
        setActiveTabId(fresh.id);
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
    setTabs((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const selectTabIndex = useCallback((index: number) => {
    const tab = tabsRef.current[index];
    if (tab) setActiveTabId(tab.id);
  }, []);

  const cycleTab = useCallback((step: 1 | -1) => {
    const prev = tabsRef.current;
    const index = prev.findIndex((t) => t.id === activeTabIdRef.current);
    if (index < 0) return;
    setActiveTabId(prev[(index + step + prev.length) % prev.length].id);
  }, []);

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
    (leafId: string) => {
      const tab = currentTab();
      if (!tab) return;
      const node = findLeaf(tab.root, leafId);
      if (!node) return;
      const nextRoot = removeLeaf(tab.root, leafId);

      if (!nextRoot) {
        releaseTerm(node.term);
        closeTab(tab.id, [node.term]);
        return;
      }

      releaseTerm(node.term);
      const fallback = leaves(nextRoot)[0].id;
      updateTab(tab.id, (t) => ({
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
      if (!tab || tab.activeLeaf === leafId) return;
      updateTab(tab.id, (t) => ({ ...t, activeLeaf: leafId }));
    },
    [currentTab, updateTab],
  );

  const toggleZoom = useCallback(
    (leafId: string) => {
      const tab = currentTab();
      if (!tab) return;
      updateTab(tab.id, (t) => ({
        ...t,
        activeLeaf: leafId,
        zoomedLeaf: t.zoomedLeaf === leafId ? null : leafId,
      }));
    },
    [currentTab, updateTab],
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
      if (best) updateTab(tab.id, (t) => ({ ...t, activeLeaf: best.id }));
    },
    [currentTab, updateTab],
  );

  const cyclePane = useCallback(
    (step: 1 | -1) => {
      const tab = currentTab();
      if (!tab) return;
      const next = nextLeaf(tab.root, tab.activeLeaf, step);
      if (next) updateTab(tab.id, (t) => ({ ...t, activeLeaf: next }));
    },
    [currentTab, updateTab],
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

      if (!restRoot) next = next.filter((t) => t.id !== source.id);

      let focus = targetTabId;
      if (!targetTabId) {
        const created: Tab = {
          id: uid("tab"),
          title: `Terminal ${next.length + 1}`,
          root: moved,
          activeLeaf: moved.id,
          zoomedLeaf: null,
        };
        next = [...next, created];
        focus = created.id;
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

  const applyProject = useCallback(
    async (path: string, options: { openTab: boolean }) => {
      try {
        const info = await projectInfo(path);
        setProject(info);
        projectRef.current = info;
        setRecents((prev) => pushRecent(prev, info.path));
        void getCurrentWindow().setTitle(`${info.name} — Duckweed`);
        if (options.openTab) {
          const term = createTerm({ cwd: info.path });
          const root = leaf(term);
          const tab: Tab = {
            id: uid("tab"),
            title: info.name,
            root,
            activeLeaf: root.id,
            zoomedLeaf: null,
          };
          setTabs([...tabsRef.current, tab]);
          setActiveTabId(tab.id);
        }
      } catch (error) {
        console.error("failed to open project", error);
        setRecents((prev) => prev.filter((p) => p !== path));
      }
    },
    [createTerm],
  );

  const openProject = useCallback(async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Open project folder",
      defaultPath: projectRef.current?.path,
    });
    if (typeof selected !== "string") return;
    await applyProject(selected, { openTab: true });
  }, [applyProject]);

  // ----------------------------------------------------------- lifecycle

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listShells();
        if (!cancelled) {
          setShells(list);
          if (!shellRef.current && list.length > 0) {
            setShell(list[0].id);
            shellRef.current = list[0].id;
          }
        }
      } catch (error) {
        console.error("failed to list shells", error);
      }

      terminals.setFontSize(initial.fontSize);
      terminals.setHighlight(initial.highlight);

      if (initial.projectPath) {
        try {
          const info = await projectInfo(initial.projectPath);
          if (!cancelled) {
            setProject(info);
            projectRef.current = info;
            void getCurrentWindow().setTitle(`${info.name} — Duckweed`);
          }
        } catch {
          if (!cancelled) setRecents((prev) => prev.filter((p) => p !== initial.projectPath));
        }
      }

      if (!cancelled) setBooted(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [initial.fontSize, initial.highlight, initial.projectPath]);

  // Persist the arrangement (never the processes). Debounced because dragging a
  // divider produces a state update per pointer move.
  useEffect(() => {
    if (!booted) return;
    const id = window.setTimeout(
      () =>
        save({ project: project?.path ?? null, recents, fontSize, shell, highlight, tabs, activeTabId }),
      400,
    );
    return () => window.clearTimeout(id);
  }, [booted, project, recents, fontSize, shell, highlight, tabs, activeTabId]);

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
      if (ctrl && !e.shiftKey && !e.altKey && key === "v" && !isTextField(e.target)) {
        if (activeTerm) terminals.focus(activeTerm);
        e.stopPropagation();
        return;
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
            if (activeLeaf) a.closePane(activeLeaf);
            return take();
          case "z":
            if (activeLeaf) a.toggleZoom(activeLeaf);
            return take();
          case "b":
            a.balancePanes();
            return take();
          case "t":
            a.newTab(null);
            return take();
          case "q":
            if (tab) a.closeTab(tab.id);
            return take();
          case "o":
            void a.openProject();
            return take();
          case "p":
            a.setPaletteOpen(true);
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
        title: "Open project folder…",
        hint: "Ctrl+Shift+O",
        run: () => void openProject(),
      },
      { id: "tab.new", group: "Tab", title: "New tab", hint: "Ctrl+Shift+T", run: () => newTab(null) },
      {
        id: "tab.close",
        group: "Tab",
        title: "Close tab",
        hint: "Ctrl+Shift+Q",
        run: () => tab && closeTab(tab.id),
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
        run: () => activeLeaf && closePane(activeLeaf),
      },
      {
        id: "pane.search",
        group: "Pane",
        title: "Find in terminal",
        hint: "Ctrl+Shift+F",
        run: () => activeLeaf && bus.emit("pane:search", { leafId: activeLeaf }),
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
        id: "view.highlight",
        group: "View",
        title: highlight ? "Turn off syntax highlighting" : "Turn on syntax highlighting",
        subtitle: "Colours output that arrives with no colour of its own",
        hint: "Ctrl+Shift+H",
        run: toggleHighlight,
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
      actions.push({
        id: `shell.tab.${info.id}`,
        group: "Shell",
        title: `New tab with ${info.label}`,
        run: () => newTab(info.id),
      });
    }

    for (const path of recents) {
      actions.push({
        id: `recent.${path}`,
        group: "Recent",
        title: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
        subtitle: path,
        run: () => void applyProject(path, { openTab: true }),
      });
    }

    tabs.forEach((t, i) => {
      actions.push({
        id: `goto.tab.${t.id}`,
        group: "Go to",
        title: `Tab: ${t.title}`,
        hint: i < 9 ? `Ctrl+${i + 1}` : undefined,
        run: () => setActiveTabId(t.id),
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
    closePane,
    closeTab,
    highlight,
    newTab,
    openProject,
    recents,
    shells,
    splitPane,
    tabs,
    toggleHighlight,
    toggleZoom,
  ]);

  // --------------------------------------------------------------- render

  const paneCounts = useMemo(
    () => Object.fromEntries(tabs.map((t) => [t.id, leaves(t.root).length])),
    [tabs],
  );

  const shared: PaneTreeShared = {
    activeLeaf: activeTab?.activeLeaf ?? "",
    drag,
    spawnFor,
    zoomedLeaf: activeTab?.zoomedLeaf ?? null,
    onActivate: activatePane,
    onSplit: (leafId, zone) => splitPane(leafId, zone),
    onClose: closePane,
    onToggleZoom: toggleZoom,
    onStartDrag,
    onResize: resizeSplitSizes,
  };

  const zoomedNode =
    activeTab?.zoomedLeaf ? findLeaf(activeTab.root, activeTab.zoomedLeaf) : null;
  const activeTerm = activeTab ? (findLeaf(activeTab.root, activeTab.activeLeaf)?.term ?? null) : null;

  return (
    <div className="app">
      <TitleBar
        project={project}
        onOpenProject={() => void openProject()}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenRecents={(e) => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setRecentsMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
      />

      <TabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        paneCounts={paneCounts}
        shells={shells}
        activeShell={shell}
        drag={drag}
        onSelect={setActiveTabId}
        onClose={(id) => closeTab(id)}
        onNew={newTab}
        onReorder={reorderTabs}
        onRename={(id, title) => updateTab(id, (t) => ({ ...t, title }))}
      />

      <main className="workspace">
        {!booted ? (
          <div className="booting">starting shell…</div>
        ) : zoomedNode && activeTab ? (
          <PaneTree node={zoomedNode} shared={shared} />
        ) : activeTab ? (
          <PaneTree node={activeTab.root} shared={shared} />
        ) : null}
      </main>

      <StatusBar
        project={project}
        paneCount={activeTab ? leaves(activeTab.root).length : 0}
        tabCount={tabs.length}
        activeTerm={activeTerm}
        fontSize={fontSize}
        onFontSize={applyFontSize}
      />

      {drag && (
        <div className="drag-ghost" style={{ transform: `translate(${drag.x + 12}px, ${drag.y + 12}px)` }}>
          <span className="pane-grip" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {drag.label}
        </div>
      )}

      {recentsMenu && (
        <>
          <div className="menu-backdrop" onPointerDown={() => setRecentsMenu(null)} />
          <div className="menu menu-recents" style={{ left: recentsMenu.x, top: recentsMenu.y }}>
            {recents.length === 0 && <div className="menu-empty">No recent projects</div>}
            {recents.map((path) => (
              <button
                key={path}
                type="button"
                className="menu-item"
                onClick={() => {
                  setRecentsMenu(null);
                  void applyProject(path, { openTab: true });
                }}
              >
                <span>{path.split(/[\\/]/).filter(Boolean).pop()}</span>
                <span className="menu-hint">{path}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {paletteOpen && <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
