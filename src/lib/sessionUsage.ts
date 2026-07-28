import { prefetchUsage, type Snapshot, type Totals } from "./usage";

/**
 * Agent usage attributed to the current Duckweed session.
 *
 * The scanner only ever reports whole calendar days, so a session figure is a
 * delta: remember what the days covering this session already held when the
 * window opened, then subtract that from every later scan. Anything an agent
 * wrote before Duckweed started stays out of the number.
 */

/** Days of history to read. Only buckets at or after the session day count. */
const RANGE_DAYS = 7;
const POLL_MS = 30_000;
/** Let the window finish opening before the first transcript scan. */
const FIRST_SCAN_DELAY_MS = 4_000;

const EMPTY: Totals = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache_read: 0,
  cache_write: 0,
  cost: 0,
  requests: 0,
};

export interface SessionAgent extends Totals {
  id: string;
  label: string;
}

export interface SessionUsage {
  /** Epoch ms the session (and so the measurement) started. */
  startedAt: number;
  totals: Totals;
  /** Agents that did something this session, most expensive first. */
  agents: SessionAgent[];
  /** Epoch ms of the last successful scan, or null before the first one. */
  updatedAt: number | null;
  /** True once a baseline exists, so a zero means "nothing yet", not "unknown". */
  ready: boolean;
  error: boolean;
  /** The wider window the session sits inside, for context under the numbers. */
  window: { days: number; totals: Totals } | null;
}

const startedAt = Date.now();

let state: SessionUsage = {
  startedAt,
  totals: EMPTY,
  agents: [],
  updatedAt: null,
  ready: false,
  error: false,
  window: null,
};

let baseline: Map<string, Totals> | null = null;
let baselineTotals: Totals = EMPTY;
let timer: number | null = null;
let firstScan: number | null = null;

const listeners = new Set<() => void>();

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => listeners.delete(listener);
}

export function getSessionUsage(): SessionUsage {
  return state;
}

export const sessionStartedAt = () => startedAt;

function publish(next: SessionUsage): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Local `YYYY-MM-DD`, matching how the backend buckets a day. */
function dayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function add(into: Totals, from: Totals): Totals {
  return {
    input: into.input + from.input,
    output: into.output + from.output,
    reasoning: into.reasoning + from.reasoning,
    cache_read: into.cache_read + from.cache_read,
    cache_write: into.cache_write + from.cache_write,
    cost: into.cost + from.cost,
    requests: into.requests + from.requests,
  };
}

/** Never negative: a rewritten transcript must not read as a refund. */
function subtract(from: Totals, taken: Totals): Totals {
  return {
    input: Math.max(0, from.input - taken.input),
    output: Math.max(0, from.output - taken.output),
    reasoning: Math.max(0, from.reasoning - taken.reasoning),
    cache_read: Math.max(0, from.cache_read - taken.cache_read),
    cache_write: Math.max(0, from.cache_write - taken.cache_write),
    cost: Math.max(0, from.cost - taken.cost),
    requests: Math.max(0, from.requests - taken.requests),
  };
}

export function tokensOf(totals: Totals): number {
  return totals.input + totals.output + totals.reasoning + totals.cache_read + totals.cache_write;
}

/** Everything the snapshot holds from the session's first day onward. */
function sumSinceStart(snapshot: Snapshot): { totals: Totals; agents: Map<string, Totals> } {
  const from = dayKey(startedAt);
  let totals = EMPTY;
  const agents = new Map<string, Totals>();
  for (const day of snapshot.days) {
    if (day.date < from) continue;
    totals = add(totals, day);
    for (const slice of day.agents) {
      agents.set(slice.agent, add(agents.get(slice.agent) ?? EMPTY, slice));
    }
  }
  return { totals, agents };
}

export function observe(snapshot: Snapshot): void {
  const { totals, agents } = sumSinceStart(snapshot);
  if (!baseline) {
    baseline = agents;
    baselineTotals = totals;
  }

  const labels = new Map(snapshot.agents.map((agent) => [agent.id, agent.label]));
  const session: SessionAgent[] = [];
  for (const [id, value] of agents) {
    const delta = subtract(value, baseline.get(id) ?? EMPTY);
    if (delta.requests === 0 && tokensOf(delta) === 0) continue;
    session.push({ ...delta, id, label: labels.get(id) ?? id });
  }
  session.sort((a, b) => b.cost - a.cost || tokensOf(b) - tokensOf(a));

  publish({
    startedAt,
    totals: subtract(totals, baselineTotals),
    agents: session,
    updatedAt: Date.now(),
    ready: true,
    error: false,
    window: { days: snapshot.range_days, totals: snapshot.totals },
  });
}

function scan(): void {
  // A short max-age keeps the poll fresh while still coalescing with whatever
  // the Usage panel is asking the shared scanner for.
  prefetchUsage(RANGE_DAYS, POLL_MS - 5_000).then(observe, () => {
    publish({ ...state, error: !state.ready });
  });
}

/**
 * Begin measuring. Idempotent, and safe to call at startup: the first scan is
 * deferred so opening the window never waits on reading transcripts.
 */
export function start(): void {
  if (timer !== null || firstScan !== null) return;
  firstScan = window.setTimeout(() => {
    firstScan = null;
    scan();
  }, FIRST_SCAN_DELAY_MS);
  timer = window.setInterval(scan, POLL_MS);
}

export function stop(): void {
  if (timer !== null) window.clearInterval(timer);
  if (firstScan !== null) window.clearTimeout(firstScan);
  timer = null;
  firstScan = null;
}

/** Cost per hour at the pace of this session, or null before it means anything. */
export function sessionPace(usage: SessionUsage, now: number): number | null {
  const hours = (now - usage.startedAt) / 3_600_000;
  if (hours < 0.05 || usage.totals.cost <= 0) return null;
  return usage.totals.cost / hours;
}
