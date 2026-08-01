import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * The chart pieces the usage dashboard is built from.
 *
 * Hand-rolled SVG rather than a charting library: the app ships no runtime
 * dependencies for the terminal itself, and four chart forms is less code than
 * the adapter layer any library would need to look like the rest of the UI.
 *
 * Shared rules, applied here so callers can't get them wrong:
 * marks are thin and capped, a 2px gap in the surface colour separates
 * touching segments, gridlines are hairline and recessive, and text always
 * wears a text token — never a series colour.
 */

/** Bars never fill their band; the leftover is what makes a column readable. */
const MAX_BAR = 22;
/** The surface gap between stacked segments. */
const GAP = 2;
const RADIUS = 4;

/** Track an element's width so the SVG can be laid out in real pixels. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

/** Round an axis to 1/2/5 x 10^n so ticks land on numbers people read. */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const multiple = [1, 2, 2.5, 5, 10].find((m) => magnitude * m >= rough) ?? 10;
  const step = magnitude * multiple;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step / 2; value += step) ticks.push(value);
  return ticks;
}

/** A rect with its top corners rounded and its base square on the axis. */
function cappedBar(x: number, y: number, width: number, height: number): string {
  const r = Math.min(RADIUS, width / 2, height);
  return [
    `M${x} ${y + height}`,
    `V${y + r}`,
    `Q${x} ${y} ${x + r} ${y}`,
    `H${x + width - r}`,
    `Q${x + width} ${y} ${x + width} ${y + r}`,
    `V${y + height}`,
    "Z",
  ].join(" ");
}

// ------------------------------------------------------------- stacked columns

export interface Series {
  key: string;
  label: string;
  color: string;
}

export interface Column {
  /** Axis tick. */
  label: string;
  /** Spelled out for the tooltip. */
  full: string;
  values: Record<string, number>;
  total: number;
}

interface StackedProps {
  columns: Column[];
  series: Series[];
  /** Turns a raw value into the text shown in the tooltip. */
  format: (value: number) => string;
  /** Axis ticks, where cents and long digits are noise. Defaults to `format`. */
  formatAxis?: (value: number) => string;
  /** What one unit is, for the tooltip heading. */
  unit: string;
  height?: number;
}

/**
 * Usage over time, split by agent. A column chart because the question is
 * "how much on each day", and stacked because the follow-up is always "from
 * which agent".
 */
export function StackedColumns({
  columns,
  series,
  format,
  formatAxis = format,
  unit,
  height = 210,
}: StackedProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const padding = { top: 12, right: 8, bottom: 24, left: 52 };
  const plotWidth = Math.max(0, width - padding.left - padding.right);
  const plotHeight = height - padding.top - padding.bottom;

  const max = Math.max(...columns.map((c) => c.total), 0);
  const ticks = niceTicks(max);
  const axisMax = ticks[ticks.length - 1] || 1;
  const scale = (value: number) => (value / axisMax) * plotHeight;

  const band = columns.length > 0 ? plotWidth / columns.length : 0;
  const barWidth = Math.max(2, Math.min(MAX_BAR, band - 8));

  const active = hover !== null ? columns[hover] : null;
  // Keep the tooltip inside the panel rather than letting it run off the edge.
  const tooltipLeft = hover !== null ? padding.left + band * (hover + 0.5) : 0;
  const anchorRight = tooltipLeft > width * 0.6;

  return (
    <div className="viz-wrap" ref={ref}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Usage per day by agent, in ${unit}`}
        >
          {ticks.map((tick) => {
            const y = padding.top + plotHeight - scale(tick);
            return (
              <g key={tick}>
                <line
                  className="viz-grid"
                  x1={padding.left}
                  x2={width - padding.right}
                  y1={y}
                  y2={y}
                />
                <text className="viz-tick" x={padding.left - 8} y={y + 4} textAnchor="end">
                  {formatAxis(tick)}
                </text>
              </g>
            );
          })}

          {columns.map((column, index) => {
            const x = padding.left + band * index + (band - barWidth) / 2;
            let cursor = 0;
            // Bottom-up, so the stack order matches the legend order and the
            // adjacent pairs stay the ones the palette was validated for.
            const drawn = series
              .map((entry) => ({ entry, value: column.values[entry.key] ?? 0 }))
              .filter(({ value }) => value > 0);

            return (
              <g key={column.label} className={hover === index ? "is-hovered" : ""}>
                {drawn.map(({ entry, value }, position) => {
                  const bottom = padding.top + plotHeight - scale(cursor);
                  cursor += value;
                  const top = padding.top + plotHeight - scale(cursor);
                  const isTop = position === drawn.length - 1;
                  // The gap sits under every segment but the first, so
                  // neighbours read as separate without a stroke.
                  const inset = position === 0 ? 0 : GAP;
                  const barHeight = bottom - top - inset;
                  if (barHeight <= 0.4) return null;
                  return isTop ? (
                    <path
                      key={entry.key}
                      className="viz-mark"
                      d={cappedBar(x, top, barWidth, barHeight)}
                      fill={entry.color}
                    />
                  ) : (
                    <rect
                      key={entry.key}
                      className="viz-mark"
                      x={x}
                      y={top}
                      width={barWidth}
                      height={barHeight}
                      fill={entry.color}
                    />
                  );
                })}
                {/* A hit target the width of the band — the bar itself is too
                    thin to point at comfortably. */}
                <rect
                  className="viz-hit"
                  x={padding.left + band * index}
                  y={padding.top}
                  width={band}
                  height={plotHeight}
                  onMouseEnter={() => setHover(index)}
                  onMouseLeave={() => setHover((current) => (current === index ? null : current))}
                />
              </g>
            );
          })}

          <line
            className="viz-axis"
            x1={padding.left}
            x2={width - padding.right}
            y1={padding.top + plotHeight}
            y2={padding.top + plotHeight}
          />

          {columns.map((column, index) => {
            // Thin the ticks rather than let them collide on a 90-day range.
            const every = Math.ceil(columns.length / Math.max(1, Math.floor(plotWidth / 62)));
            if (index % every !== 0 && index !== columns.length - 1) return null;
            return (
              <text
                key={column.label}
                className="viz-tick"
                x={padding.left + band * (index + 0.5)}
                y={height - 7}
                textAnchor="middle"
              >
                {column.label}
              </text>
            );
          })}
        </svg>
      )}

      {active && (
        <div
          className="viz-tip"
          style={
            anchorRight
              ? { right: Math.max(4, width - tooltipLeft) }
              : { left: Math.max(4, tooltipLeft) }
          }
        >
          <strong>{active.full}</strong>
          <span className="viz-tip-total">
            {format(active.total)} {unit}
          </span>
          {series
            .map((entry) => ({ entry, value: active.values[entry.key] ?? 0 }))
            .filter(({ value }) => value > 0)
            .reverse()
            .map(({ entry, value }) => (
              <span key={entry.key} className="viz-tip-row">
                <i style={{ background: entry.color }} aria-hidden="true" />
                {entry.label}
                <b>{format(value)}</b>
              </span>
            ))}
          {active.total === 0 && <span className="viz-tip-row">No usage</span>}
        </div>
      )}
    </div>
  );
}

/** Identity, spelled out — never make the reader match colours from memory. */
export function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="viz-legend">
      {series.map((entry) => (
        <li key={entry.key}>
          <i style={{ background: entry.color }} aria-hidden="true" />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------- bar list

export interface BarRow {
  key: string;
  label: string;
  /** Sits under the label — a model's agent, an agent's vendor. */
  sub?: string;
  value: number;
  /** Right-aligned, already formatted. */
  display: string;
  color: string;
  /** Shown after the value when the number comes with a caveat. */
  note?: string;
}

/**
 * A ranked list of bars. Horizontal because the labels are model and agent
 * names, which need room to be read.
 */
export function BarList({ rows, empty }: { rows: BarRow[]; empty: string }) {
  if (rows.length === 0) return <p className="usage-empty">{empty}</p>;
  const max = Math.max(...rows.map((row) => row.value), 0);
  return (
    <ul className="viz-bars">
      {rows.map((row) => (
        <li key={row.key}>
          <div className="viz-bars-head">
            <span className="viz-bars-label">
              <i style={{ background: row.color }} aria-hidden="true" />
              <span>
                {row.label}
                {row.sub && <small>{row.sub}</small>}
              </span>
            </span>
            <span className="viz-bars-value">
              {row.display}
              {row.note && <small>{row.note}</small>}
            </span>
          </div>
          <div className="viz-bars-track">
            <div
              className="viz-bars-fill"
              style={{
                width: max > 0 ? `${Math.max(1.5, (row.value / max) * 100)}%` : "0%",
                background: row.color,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------- meter

/**
 * A quota bar for remaining allowance. The fill starts full and drains as the
 * window is consumed. Severity is carried by the fill colour, and repeated as
 * text, so the state never depends on colour alone.
 */
export function Meter({
  label,
  value,
  percent,
  hint,
  unknown,
}: {
  label: string;
  value: string;
  /** How much of the limit is still left (0–100). */
  percent: number;
  hint?: string;
  /** No limit configured: show the number, skip the bar. */
  unknown?: boolean;
}) {
  const remaining = Math.max(0, Math.min(100, percent));
  // Drain toward empty: red under 10%, yellow under 30%, otherwise green.
  const level = remaining < 10 ? "is-critical" : remaining < 30 ? "is-warning" : "is-ok";
  return (
    <div className="viz-meter">
      <div className="viz-meter-head">
        <span>{label}</span>
        <span className="viz-meter-value">
          {value}
          {hint && <small>{hint}</small>}
        </span>
      </div>
      {unknown ? (
        <div className="viz-meter-track is-empty" aria-hidden="true" />
      ) : (
        <div
          className={`viz-meter-track ${level}`}
          role="meter"
          aria-valuenow={Math.round(remaining)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label} remaining`}
        >
          <div className="viz-meter-fill" style={{ width: `${remaining}%` }} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- stat tile

export function StatTile({
  label,
  value,
  detail,
  trend,
}: {
  label: string;
  value: string;
  detail?: string;
  /** A sparkline of the same series the value summarizes. */
  trend?: number[];
}) {
  return (
    <div className="usage-stat">
      <span className="usage-stat-label">{label}</span>
      <strong className="usage-stat-value">{value}</strong>
      {detail && <span className="usage-stat-detail">{detail}</span>}
      {trend && trend.length > 1 && <Sparkline points={trend} />}
    </div>
  );
}

/** Twelve-ish points of shape, no axes — context for the number above it. */
export function Sparkline({ points }: { points: number[] }) {
  const width = 96;
  const height = 22;
  const max = Math.max(...points, 0);
  if (max <= 0) return <svg className="usage-spark" width={width} height={height} aria-hidden="true" />;

  const step = points.length > 1 ? width / (points.length - 1) : width;
  const y = (value: number) => height - 2 - (value / max) * (height - 4);
  const line = points.map((value, index) => `${index * step},${y(value)}`).join(" ");
  const area = `0,${height} ${line} ${width},${height}`;

  return (
    <svg className="usage-spark" width={width} height={height} aria-hidden="true">
      <polygon className="usage-spark-area" points={area} />
      <polyline className="usage-spark-line" points={line} />
      <circle
        className="usage-spark-dot"
        cx={(points.length - 1) * step}
        cy={y(points[points.length - 1])}
        r={2.5}
      />
    </svg>
  );
}

// ------------------------------------------------------------- table view

/**
 * The same numbers as a table. Always available: it is the fallback for
 * anyone the colours don't work for, and the fastest way to read an exact
 * figure.
 */
export function TableView({
  columns,
  rows,
  open,
  onToggle,
}: {
  columns: string[];
  rows: ReactNode[][];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="usage-table-wrap">
      <button type="button" className="usage-linkish" onClick={onToggle}>
        {open ? "Hide table" : "Show as table"}
      </button>
      {open && (
        <div className="usage-table-scroll">
          <table className="usage-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
