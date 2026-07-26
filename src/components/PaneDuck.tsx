import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import {
  DUCK_FPS,
  type DuckLayout,
  duckFontSize,
  duckLayout,
  renderDuckFrame,
} from "../lib/duckAscii";

/** Columns in the metrics probe: enough that rounding cannot skew the cell. */
const PROBE_COLS = 64;

function sameLayout(a: DuckLayout | null, b: DuckLayout): boolean {
  return (
    a !== null &&
    a.font === b.font &&
    a.cols === b.cols &&
    a.rows === b.rows &&
    a.duckCols === b.duckCols
  );
}

/**
 * The empty-state duck uses a measured character grid and a 15 FPS clock.
 * Its renderer returns complete ASCII layers for each frame; CSS only colors
 * and stacks those layers.
 */
function AnimatedDuck() {
  const hostRef = useRef<HTMLDivElement>(null);
  const inkRef = useRef<HTMLPreElement>(null);
  const sceneRef = useRef<HTMLPreElement>(null);
  const [layout, setLayout] = useState<DuckLayout | null>(null);
  const phase = useMemo(() => Math.random() * 60, []);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const probe = document.createElement("pre");
    probe.className = "duck-probe";
    probe.textContent = `${"0".repeat(PROBE_COLS)}\n0\n0`;
    el.appendChild(probe);

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) {
        setLayout(null);
        return;
      }
      const font = duckFontSize(width, height);
      probe.style.fontSize = `${font}px`;
      const box = probe.getBoundingClientRect();
      const next = duckLayout(width, height, box.width / PROBE_COLS, box.height / 3, font);
      setLayout((prev) => (sameLayout(prev, next) ? prev : next));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      probe.remove();
    };
  }, []);

  useEffect(() => {
    const ink = inkRef.current;
    const scene = sceneRef.current;
    if (!layout || !ink || !scene) return;

    const draw = (seconds: number) => {
      const frame = renderDuckFrame(layout, seconds);
      ink.textContent = frame.duck;
      scene.textContent = frame.water;
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      draw(phase);
      return;
    }

    let raf = 0;
    let last = -Infinity;
    const step = (ms: number) => {
      raf = requestAnimationFrame(step);
      if (ms - last < 1000 / DUCK_FPS) return;
      last = ms;
      draw(phase + ms / 1000);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [layout, phase]);

  return (
    <div ref={hostRef} className="duck-pond">
      {layout && (
        <div
          className="duck-stage is-animated"
          style={
            {
              fontSize: `${layout.font}px`,
              "--duck-cols": layout.cols,
              "--duck-rows": layout.rows,
            } as CSSProperties
          }
        >
          <pre ref={sceneRef} className="duck-water" />
          <pre ref={inkRef} className="duck-ink" />
        </div>
      )}
    </div>
  );
}

export function PaneDuck() {
  return <AnimatedDuck />;
}
