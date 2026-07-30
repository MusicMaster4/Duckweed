import { useEffect, useState } from "react";

import {
  ASCII_SCENES,
  type AsciiSceneId,
  type PainterFactory,
} from "./agent/ascii/animations";
import type { Painter } from "./agent/ascii/canvas";

const DEFAULT_FPS = 12;
/** Ambient surfaces remount often (panel swaps); keep clocks across that. */
const REGISTRY_LIMIT = 32;

interface Assignment {
  paint: Painter;
  origin: number;
  scene: AsciiSceneId;
}

const assignments = new Map<string, Assignment>();

function assignmentFor(surfaceId: string, scene: AsciiSceneId, factory: PainterFactory): Assignment {
  const existing = assignments.get(surfaceId);
  if (existing && existing.scene === scene) return existing;

  const assignment: Assignment = {
    paint: factory(),
    origin: performance.now(),
    scene,
  };
  if (assignments.size >= REGISTRY_LIMIT) {
    const oldest = assignments.keys().next().value;
    if (oldest !== undefined) assignments.delete(oldest);
  }
  assignments.set(surfaceId, assignment);
  return assignment;
}

/**
 * Quiet ASCII decoration for tool empty states and long waits.
 *
 * Unlike the agent startup loader, each call site names its scene so Ports
 * always pings, PowerWatch always watches, and so on. The only random piece is
 * the agent pool; these surfaces are intentional.
 */
export function AsciiAmbient({
  surfaceId,
  scene,
  className,
  fps = DEFAULT_FPS,
}: {
  /** Stable key for this surface so remounts keep the same clock. */
  surfaceId: string;
  scene: AsciiSceneId;
  className?: string;
  /**
   * Paint rate. Quiet ambients stay at 12; short celebrations can run higher
   * so fall motion reads smooth instead of stepped.
   */
  fps?: number;
}) {
  const factory = ASCII_SCENES[scene];
  const { paint, origin } = assignmentFor(surfaceId, scene, factory);
  const [frame, setFrame] = useState(() => paint((performance.now() - origin) / 1000));
  const frameMs = 1000 / Math.max(1, fps);

  useEffect(() => {
    setFrame(paint((performance.now() - origin) / 1000));
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let handle = 0;
    let last = 0;
    const tick = (now: number) => {
      handle = window.requestAnimationFrame(tick);
      if (now - last < frameMs) return;
      last = now;
      setFrame(paint((now - origin) / 1000));
    };
    handle = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(handle);
  }, [paint, origin, frameMs]);

  return (
    <div className={`ascii-ambient${className ? ` ${className}` : ""}`} aria-hidden="true">
      <pre>{frame}</pre>
    </div>
  );
}
