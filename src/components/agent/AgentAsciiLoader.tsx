import { useEffect, useState } from "react";

import type { AgentId } from "../../lib/agents/types";
import { createCooldownPicker } from "../../lib/cooldownPicker";
import { ASCII_ANIMATIONS } from "./ascii/animations";
import type { Painter } from "./ascii/canvas";

const FPS = 24;
/** Enough for any plausible number of live panes, without growing forever. */
const REGISTRY_LIMIT = 64;

interface Assignment {
  paint: Painter;
  /** performance.now() when this terminal's animation first started. */
  origin: number;
}

/**
 * Splitting or closing a pane re-parents the whole terminal subtree, so React
 * unmounts and remounts this component even though it is the same terminal —
 * a stable `key` cannot prevent it, because the node moves to a new depth in
 * the element tree. Anything held in component state is lost with it.
 *
 * Keying off the terminal id instead of component identity survives that: the
 * same terminal keeps its animation *and* its clock, so a remount is invisible
 * rather than a jump back to a different animation at frame zero. A genuinely
 * new terminal is a new id, and draws again.
 */
const assignments = new Map<string, Assignment>();

/**
 * Draws with the usual half-pool cooldown: a freshly assigned animation sits
 * out the next floor(pool / 2) assignments, so terminals opened back to back
 * never start on the same art. The random source is late-bound so tests that
 * stub Math.random can fix the draw.
 */
const pickAnimation = createCooldownPicker(ASCII_ANIMATIONS, ASCII_ANIMATIONS[0]!, () =>
  Math.random(),
);

function assignmentFor(termId: string): Assignment {
  const existing = assignments.get(termId);
  if (existing) return existing;

  const factory = pickAnimation();
  const assignment: Assignment = { paint: factory(), origin: performance.now() };
  if (assignments.size >= REGISTRY_LIMIT) {
    const oldest = assignments.keys().next().value;
    if (oldest !== undefined) assignments.delete(oldest);
  }
  assignments.set(termId, assignment);
  return assignment;
}

/**
 * Startup art. The animation is drawn from a shared pool (random, with a
 * half-pool cooldown against recent draws) rather than being bound to a
 * provider: the provider only supplies the colour, by way of `--agent-accent`.
 */
export function AgentAsciiLoader({
  agent,
  termId,
  label = "Starting session",
  progress = true,
}: {
  agent: AgentId;
  /** Identifies the terminal this animation belongs to; see `assignments`. */
  termId: string;
  label?: string;
  /** Startup shows the sweep bar and label; the idle empty state does not. */
  progress?: boolean;
}) {
  const { paint, origin } = assignmentFor(termId);
  const [frame, setFrame] = useState(() => paint((performance.now() - origin) / 1000));

  useEffect(() => {
    setFrame(paint((performance.now() - origin) / 1000));
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let handle = 0;
    let last = 0;
    const tick = (now: number) => {
      handle = window.requestAnimationFrame(tick);
      if (now - last < 1000 / FPS) return;
      last = now;
      setFrame(paint((now - origin) / 1000));
    };
    handle = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(handle);
  }, [paint, origin]);

  return (
    <div
      className={`agent-ascii-loader is-${agent}${progress ? "" : " is-ambient"}`}
      role={progress ? "status" : "presentation"}
      aria-label={progress ? label : undefined}
    >
      <pre aria-hidden="true">{frame}</pre>
      {progress && <span className="agent-ascii-bar" aria-hidden="true" />}
      {progress && <span className="agent-ascii-label">{label}</span>}
    </div>
  );
}
