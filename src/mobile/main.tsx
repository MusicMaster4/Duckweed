import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentTimeline } from "../components/agent/AgentTimeline";
import { AppErrorBoundary } from "../components/AppErrorBoundary";
import { AgentGoalIndicator } from "../components/agent/AgentGoalIndicator";
import { PlanTracker } from "../components/agent/official/OfficialShared";
import { SubagentUiProvider } from "../components/agent/subagents/SubagentUiContext";
import { SubagentFocus } from "../components/agent/subagents/SubagentFocus";
import { subagentForCallId, subagentRosters } from "../lib/agents/subagents";
import { emptyUsage, type AgentItem, type AgentSessionState } from "../lib/agents/types";
import { latestWorkflow } from "../lib/agentWorkflow";
import type { MobileAgentExperience } from "../lib/mobileExperience";
import "../styles.css";
import "../components/agent/subagents/subagents.css";
import "./mobile.css";

interface Update { key: string; experience: MobileAgentExperience; online: boolean; outgoing?: Array<{ id: string; at: number; text: string; state: string }> }
declare global { interface Window { duckweedUpdate: (value: Update) => void; duckweedPause: () => void } }

function Conversation() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [paused, setPaused] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [jump, setJump] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const keyRef = useRef("");
  const previousItems = useRef<AgentItem[]>([]);
  const [items, setItems] = useState<AgentItem[]>([]);
  useEffect(() => {
    window.duckweedPause = () => setPaused(true);
    window.duckweedUpdate = value => {
      setPaused(false);
      if (keyRef.current !== value.key) {
        keyRef.current = value.key;
        previousItems.current = [];
        pinned.current = true;
        setFocused(null);
      }
      // Keep already received rich history as the relay's bounded tail rolls forward.
      const merged = new Map(previousItems.current.map(item => [item.id, item]));
      for (const item of value.experience.items) merged.set(item.id, item);
      previousItems.current = [...merged.values()].sort((a, b) => a.at - b.at).slice(-1_200);
      setItems(previousItems.current);
      setUpdate(value);
    };
    return () => { window.duckweedUpdate = () => {}; window.duckweedPause = () => {}; };
  }, []);
  useLayoutEffect(() => {
    const surface = scroll.current;
    if (!surface) return;
    const follow = () => { if (pinned.current) surface.scrollTop = surface.scrollHeight; };
    follow();
    const observer = new ResizeObserver(follow);
    for (const child of surface.children) observer.observe(child);
    return () => observer.disconnect();
  }, [items, focused]);
  if (!update) return <div className="mobile-loading" role="status">Opening conversation...</div>;
  const experience = update.experience;
  const session: AgentSessionState = { models: [], commands: [], pending: [], permission: null,
    ...experience, status: update.online && !paused ? experience.status : "idle", items,
    usage: experience.usage ?? emptyUsage(),
  };
  const outgoing = (update.outgoing ?? []).filter(message =>
    !items.some(item => item.kind === "user" && item.text.trim() === message.text.trim() && item.at >= message.at - 10_000));
  const visibleItems: AgentItem[] = [...items, ...outgoing.map(message => ({ kind: "user" as const, id: message.id, at: message.at, text: message.text }))];
  const plan = latestWorkflow(items);
  const child = focused ? subagentForCallId(items, focused) : null;
  const variant = session.agent === "codex" ? "chatgpt" : session.agent;
  return <SubagentUiProvider agent={session.agent} now={Date.now()} rosters={subagentRosters(items)}
    focusedCallId={focused} peekedCallId={null} onPeek={setFocused} onOpen={setFocused}
    onClosePeek={() => setFocused(null)} onLeaveFocus={() => setFocused(null)}>
    <main data-agent={session.agent} className="mobile-conversation" style={{ "--agent-accent": session.accent } as React.CSSProperties}>
      <div ref={scroll} className="agent-scroll mobile-scroll" onScroll={() => {
        const surface = scroll.current!;
        pinned.current = surface.scrollHeight - surface.scrollTop - surface.clientHeight < 56;
        setJump(!pinned.current);
      }}>
        {session.goal && <AgentGoalIndicator goal={session.goal} />}
        {child ? <><button className="mobile-back" onClick={() => setFocused(null)}>Back to conversation</button>
          <SubagentFocus subagent={child} agent={session.agent} parentLabel={session.label} parentWorking={session.status === "working"} now={Date.now()} onBack={() => setFocused(null)} showBack={false} />
        </> : <AgentTimeline session={session} items={plan ? visibleItems.filter(item => item.kind !== "plan") : visibleItems}
          termId={session.termId} agent={session.agent} status={session.status} started={session.started}
          label={session.label} mark={session.mark} program={session.program} cwd={session.cwd} />}
      </div>
      {outgoing.length > 0 && <div className="mobile-delivery" role="status">{outgoing.at(-1)?.state === "failed" ? "Message could not be sent. Open conversation actions to retry." : "Sending to desktop..."}</div>}
      {jump && <button className="mobile-jump" onClick={() => {
        pinned.current = true; setJump(false); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" });
      }}>Jump to latest</button>}
      {!child && plan && <PlanTracker item={plan} variant={variant} />}
    </main>
  </SubagentUiProvider>;
}
createRoot(document.getElementById("root")!).render(<AppErrorBoundary><Conversation /></AppErrorBoundary>);
