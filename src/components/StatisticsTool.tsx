import { useEffect, useState, useSyncExternalStore } from "react";

import * as commandHistory from "../lib/commandHistory";
import { portsList } from "../lib/ipc";
import {
  getSessionUsage,
  sessionPace,
  subscribe as subscribeSessionUsage,
  tokensOf,
  type SessionAgent,
} from "../lib/sessionUsage";
import { agentColor, compactNumber, formatUsd } from "../lib/usage";

/** Agents drawn on their own in the split; the rest collapse into one bar. */
const NAMED_AGENTS = 4;

interface Props {
  tabs: number;
  panes: number;
  projects: number;
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function paceLabel(perHour: number): string {
  if (perHour >= 100) return `$${Math.round(perHour)}/h`;
  if (perHour >= 10) return `$${perHour.toFixed(1)}/h`;
  if (perHour >= 1) return `$${perHour.toFixed(2)}/h`;
  return `${formatUsd(perHour)}/h`;
}

/**
 * The split under the session cost.
 *
 * Money is the honest weight here, but an agent whose model has no known price
 * would silently vanish from the bar, so a session with no priced spend falls
 * back to token share instead of drawing nothing.
 */
function AgentSplit({ agents }: { agents: SessionAgent[] }) {
  const byCost = agents.some((agent) => agent.cost > 0);
  const weigh = (agent: SessionAgent) => (byCost ? agent.cost : tokensOf(agent));
  const total = agents.reduce((sum, agent) => sum + weigh(agent), 0);
  if (total <= 0) return null;

  const named = agents.slice(0, NAMED_AGENTS);
  const rest = agents.slice(NAMED_AGENTS);
  const restWeight = rest.reduce((sum, agent) => sum + weigh(agent), 0);

  const share = (weight: number) => `${Math.max(1.5, (weight / total) * 100)}%`;

  return (
    <div className="statistics-split">
      <div className="statistics-split-bar" role="presentation">
        {named.map((agent) => (
          <span
            key={agent.id}
            style={{ width: share(weigh(agent)), background: agentColor(agent.id) }}
            title={`${agent.label}: ${formatUsd(agent.cost)}`}
          />
        ))}
        {restWeight > 0 && (
          <span
            style={{ width: share(restWeight), background: "var(--viz-muted)" }}
            title={`${rest.length} more agents`}
          />
        )}
      </div>
      <ul className="statistics-rows">
        {named.map((agent) => (
          <li key={agent.id}>
            <i style={{ background: agentColor(agent.id) }} aria-hidden="true" />
            <span>{agent.label}</span>
            <b>{byCost ? formatUsd(agent.cost) : compactNumber(tokensOf(agent))}</b>
          </li>
        ))}
        {rest.length > 0 && (
          <li>
            <i style={{ background: "var(--viz-muted)" }} aria-hidden="true" />
            <span>{rest.length} more</span>
            <b>{byCost ? formatUsd(restWeight) : compactNumber(restWeight)}</b>
          </li>
        )}
      </ul>
    </div>
  );
}

/** One label/value line. Every number in the panel is read the same way. */
function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <li title={hint}>
      <span>{label}</span>
      <b>{value}</b>
    </li>
  );
}

export function StatisticsTool({ tabs, panes, projects }: Props) {
  const [now, setNow] = useState(Date.now());
  /** The pace is an average, so a second-by-second redraw is only noise. */
  const [paceAt, setPaceAt] = useState(now);
  const [servers, setServers] = useState<number | null>(null);
  const usage = useSyncExternalStore(subscribeSessionUsage, getSessionUsage, getSessionUsage);
  const savedCommands = useSyncExternalStore(
    commandHistory.subscribe,
    () => commandHistory.list().length,
    () => commandHistory.list().length,
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    const slow = window.setInterval(() => setPaceAt(Date.now()), 20_000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(slow);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void portsList().then(
        (snapshot) => {
          if (!disposed) setServers(snapshot.ports.length);
        },
        () => {
          if (!disposed) setServers(null);
        },
      );
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const tokens = tokensOf(usage.totals);
  const requests = usage.totals.requests;
  const worked = usage.ready && (requests > 0 || tokens > 0);
  const pace = sessionPace(usage, Math.max(paceAt, usage.updatedAt ?? 0));

  return (
    <section className="statistics-tool" aria-label="Application statistics">
      <div className="tools-section-head statistics-head">
        <div>
          <span className="tools-section-title">Statistics</span>
          <span className="tools-section-note">Since this window opened</span>
        </div>
        <span className="statistics-uptime" title="App uptime">
          {formatUptime(now - usage.startedAt)}
        </span>
      </div>

      <div className="statistics-scroll">
        <article className="statistics-card">
          <header>
            <span className="statistics-card-title">Estimated cost</span>
            {pace !== null && (
              <em className="statistics-pace" title="At this session's pace">
                {paceLabel(pace)}
              </em>
            )}
          </header>
          <strong className="statistics-amount">{formatUsd(usage.totals.cost)}</strong>

          {worked ? (
            <>
              <p className="statistics-meta">
                <span>
                  <b>{compactNumber(tokens)}</b> tokens
                </span>
                <span>
                  <b>{compactNumber(requests)}</b> {requests === 1 ? "request" : "requests"}
                </span>
                <span>
                  <b>{compactNumber(usage.totals.output)}</b> written
                </span>
              </p>
              <AgentSplit agents={usage.agents} />
            </>
          ) : (
            <p className="statistics-note">
              {usage.error
                ? "Usage unavailable"
                : usage.ready
                  ? "No agent has run this session"
                  : "Reading transcripts..."}
            </p>
          )}
        </article>

        <article className="statistics-card">
          <header>
            <span className="statistics-card-title">Workspace</span>
          </header>
          <ul className="statistics-rows">
            <Row label="Tabs" value={String(tabs)} />
            <Row label="Panes" value={String(panes)} />
            <Row label="Projects" value={String(projects)} hint="Folders open in a tab" />
            <Row
              label="Listening ports"
              value={servers === null ? "..." : String(servers)}
              hint="Ports your processes listen on"
            />
            <Row
              label="Saved commands"
              value={compactNumber(savedCommands)}
              hint="Commands kept for suggestions"
            />
          </ul>
        </article>

        {usage.window && (
          <article className="statistics-card">
            <header>
              <span className="statistics-card-title">Last {usage.window.days} days</span>
            </header>
            <ul className="statistics-rows">
              <Row label="Spend" value={formatUsd(usage.window.totals.cost)} />
              <Row label="Tokens" value={compactNumber(tokensOf(usage.window.totals))} />
            </ul>
          </article>
        )}
      </div>
    </section>
  );
}
