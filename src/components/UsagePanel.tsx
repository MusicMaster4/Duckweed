import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { BarList, Legend, Meter, StackedColumns, StatTile, TableView } from "./UsageCharts";
import type { BarRow, Column, Series } from "./UsageCharts";
import {
  RANGES,
  agentColor,
  dayFull,
  dayTick,
  describeForecast,
  formatBytes,
  formatExact,
  formatQuotaValue,
  formatTokens,
  formatUsd,
  formatUsdAxis,
  cachedUsage,
  loadSettings,
  prefetchUsage,
  quotaRemaining,
  saveSettings,
  untilReset,
  type Metric,
  type Snapshot,
  type UsageSettings,
} from "../lib/usage";

const totalOf = (row: {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
}) => row.input + row.output + row.reasoning + row.cache_read + row.cache_write;

/**
 * What every coding agent on this machine has cost you.
 *
 * Token and cost numbers come from transcripts each CLI already writes. Quota
 * meters may query a provider's official endpoint with the CLI's existing
 * local OAuth session; transcript contents never leave the machine.
 */
export function UsagePanel() {
  const [settings, setSettings] = useState<UsageSettings>(loadSettings);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() => cachedUsage(settings.days));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !cachedUsage(settings.days));
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** Bumped by the refresh button to run another incremental scan. */
  const [reload, setReload] = useState(0);

  const update = useCallback((patch: Partial<UsageSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  // The first scan reads every transcript on disk, so it reports progress
  // rather than sitting on a blank panel.
  useEffect(() => {
    const stop = listen<[number, number]>("usage:progress", (event) => {
      const [done, total] = event.payload;
      setProgress(total > 0 && done < total ? { done, total } : null);
    });
    return () => {
      void stop.then((off) => off());
    };
  }, []);

  // Reset countdowns and burn forecasts are read against the wall clock, so
  // they keep ticking between scans instead of freezing at the last fetch.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const { days, metric } = settings;

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      const ready = cachedUsage(days);
      if (ready) setSnapshot(ready);
      setLoading(!ready);
      prefetchUsage(days, reload > 0 ? 0 : 15_000)
        .then((result) => {
          if (cancelled) return;
          setSnapshot(result);
          setNow(Date.now());
          setError(null);
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(String(cause));
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
            setProgress(null);
          }
        });
    }, 50);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [days, reload]);

  const refresh = () => setReload((count) => count + 1);

  // ---- derived --------------------------------------------------------
  const value = useCallback(
    (row: {
      cost: number;
      input: number;
      output: number;
      reasoning: number;
      cache_read: number;
      cache_write: number;
    }) => (metric === "cost" ? row.cost : totalOf(row)),
    [metric],
  );
  const format = metric === "cost" ? formatUsd : formatTokens;
  const formatAxis = metric === "cost" ? formatUsdAxis : formatTokens;
  const unit = metric === "cost" ? "spent" : "tokens";

  /** Only agents with something to show get a colour and a stack slot. */
  const series: Series[] = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.agents
      .filter((agent) => agent.installed || value(agent) > 0)
      .filter((agent) => snapshot.days.some((day) => day.agents.some((slice) => slice.agent === agent.id)))
      .map((agent) => ({ key: agent.id, label: agent.label, color: agentColor(agent.id) }));
  }, [snapshot, value]);

  const columns: Column[] = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.days.map((day) => {
      const values: Record<string, number> = {};
      for (const slice of day.agents) values[slice.agent] = value(slice);
      return {
        label: dayTick(day.date),
        full: dayFull(day.date),
        values,
        total: value(day),
      };
    });
  }, [snapshot, value]);

  const agentRows: BarRow[] = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.agents
      .filter((agent) => agent.installed && value(agent) > 0)
      .map((agent) => ({
        key: agent.id,
        label: agent.label,
        sub: agent.vendor,
        value: value(agent),
        display: format(value(agent)),
        color: agentColor(agent.id),
        note:
          metric === "cost" && agent.cost === 0
            ? "no rate"
            : `${formatExact(agent.requests)} req`,
      }))
      .sort((a, b) => b.value - a.value);
  }, [snapshot, value, format]);

  const modelRows: BarRow[] = useMemo(() => {
    if (!snapshot) return [];
    const labels = new Map(snapshot.agents.map((agent) => [agent.id, agent.label]));
    return snapshot.models
      .filter((model) => value(model) > 0)
      .slice(0, 12)
      .map((model) => ({
        key: `${model.agent}:${model.model}`,
        label: model.model,
        sub: labels.get(model.agent) ?? model.agent,
        value: value(model),
        // Colour follows the agent, so a model keeps its identity across
        // every chart on the page.
        color: agentColor(model.agent),
        display: format(value(model)),
        ...(metric === "cost" && !model.priced ? { note: "no rate" } : {}),
      }));
  }, [snapshot, value, format, metric]);

  // Both sparklines stay visible at the top regardless of which metric the
  // charts below are currently showing.
  const costTrend = useMemo(
    () => (snapshot ? snapshot.days.map((day) => day.cost) : []),
    [snapshot],
  );
  const tokenTrend = useMemo(
    () => (snapshot ? snapshot.days.map((day) => totalOf(day)) : []),
    [snapshot],
  );

  const busiest = agentRows[0];
  const totals = snapshot?.totals;
  const totalTokens = totals ? totalOf(totals) : 0;
  const cacheShare =
    totals && totalTokens > 0 ? Math.round((totals.cache_read / totalTokens) * 100) : 0;

  const catalogue = snapshot?.agents ?? [];
  const installedCount = catalogue.filter((agent) => agent.installed).length;

  // ---- render ----------------------------------------------------------
  if (error) {
    return (
      <section className="settings-section">
        <h2>Usage</h2>
        <div className="usage-error">
          <strong>Could not read usage data</strong>
          <span>{error}</span>
          <button type="button" className="usage-button" onClick={refresh}>
            Try again
          </button>
        </div>
      </section>
    );
  }

  if (!snapshot) {
    return (
      <section className="settings-section">
        <h2>Usage</h2>
        <div className="usage-loading">
          <span className="usage-spinner" aria-hidden="true" />
          <span>
            {progress
              ? `Indexing transcripts — ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} files`
              : "Reading agent transcripts…"}
          </span>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="settings-section usage-section">
        <header className="usage-header">
          <div>
            <h2>Usage</h2>
            <p className="usage-sub">
              Tokens and costs come from local session logs. Quota checks use only official
              provider endpoints.
            </p>
          </div>
          <div className="usage-controls">
            <div className="usage-segment" role="group" aria-label="Metric">
              {(["cost", "tokens"] as Metric[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={metric === option ? "is-active" : ""}
                  onClick={() => update({ metric: option })}
                >
                  {option === "cost" ? "Cost" : "Tokens"}
                </button>
              ))}
            </div>
            <div className="usage-segment" role="group" aria-label="Date range">
              {RANGES.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={days === option ? "is-active" : ""}
                  onClick={() => update({ days: option })}
                >
                  {option}d
                </button>
              ))}
            </div>
            <button
              type="button"
              className="usage-button"
              onClick={refresh}
              disabled={loading}
              title="Check for changed transcripts"
            >
              {loading ? "Scanning…" : "Refresh"}
            </button>
          </div>
        </header>

        <div className="usage-stats">
          <StatTile
            label={`Spend, last ${snapshot.range_days} days`}
            value={formatUsd(totals?.cost ?? 0)}
            detail="Estimated from list prices"
            trend={costTrend}
          />
          <StatTile
            label="Tokens"
            value={formatTokens(totalTokens)}
            detail={`${cacheShare}% served from cache`}
            trend={tokenTrend}
          />
          <StatTile
            label="Requests"
            value={formatExact(totals?.requests ?? 0)}
            detail={`across ${agentRows.length} agent${agentRows.length === 1 ? "" : "s"}`}
          />
          <StatTile
            label="Most used"
            value={busiest ? busiest.label : "—"}
            detail={busiest ? `${busiest.display} ${unit}` : "No activity in range"}
          />
        </div>
      </section>

      <section className="settings-section usage-section">
        <h2>{metric === "cost" ? "Spend" : "Tokens"} per day</h2>
        <Legend series={series} />
        <StackedColumns
          columns={columns}
          series={series}
          format={format}
          formatAxis={formatAxis}
          unit={unit}
        />
        <TableView
          open={showTable}
          onToggle={() => setShowTable((open) => !open)}
          columns={["Day", ...series.map((entry) => entry.label), "Total"]}
          rows={snapshot.days.map((day) => [
            dayFull(day.date),
            ...series.map((entry) => {
              const slice = day.agents.find((item) => item.agent === entry.key);
              return slice ? format(value(slice)) : "—";
            }),
            format(value(day)),
          ])}
        />
      </section>

      <section className="settings-section usage-section">
        <h2>By agent</h2>
        <BarList rows={agentRows} empty="No agent activity in this range." />
      </section>

      <section className="settings-section usage-section">
        <h2>By model</h2>
        <BarList rows={modelRows} empty="No model activity in this range." />
        {metric === "cost" && snapshot.unpriced.length > 0 && (
          <p className="usage-note">
            No published rate for {snapshot.unpriced.length} model
            {snapshot.unpriced.length === 1 ? "" : "s"} ({snapshot.unpriced.slice(0, 3).join(", ")}
            {snapshot.unpriced.length > 3 ? "…" : ""}). Their tokens are counted; their cost is
            not.
          </p>
        )}
      </section>

      <section className="settings-section usage-section">
        <h2>Quota management</h2>
        <p className="usage-sub">
          Provider-reported limits for agents used in the selected period. Duckweed never invents
          a quota from transcript totals. The line under each bar projects that limit against its
          own reset, from your measured burn rate.
        </p>
        {snapshot.quotas.length > 0 ? (
          <div className="usage-quota-grid">
            {snapshot.quotas.map((quota) => (
              <article
                key={quota.agent}
                className={`usage-quota ${quota.source === "unavailable" ? "is-unavailable" : ""}`}
              >
                <header>
                  <span className="usage-quota-name">
                    <i style={{ background: agentColor(quota.agent) }} aria-hidden="true" />
                    {quota.label}
                  </span>
                  {quota.plan && (
                    <span className="usage-quota-plan" title={`Plan: ${quota.plan}`}>
                      {quota.plan}
                    </span>
                  )}
                </header>
                {quota.limits.map((limit) => {
                  const remaining = quotaRemaining(limit);
                  const forecast = describeForecast(limit, now);
                  return (
                    <div key={limit.id} className="usage-quota-row">
                      <Meter
                        label={limit.label}
                        value={formatQuotaValue(remaining, limit.unit)}
                        percent={Math.max(0, 100 - limit.percent)}
                        {...(limit.resets_at
                          ? { hint: `resets ${untilReset(limit.resets_at, now)}` }
                          : {})}
                      />
                      <p className={`usage-quota-forecast is-${forecast.tone}`}>
                        <i aria-hidden="true" />
                        <span>{forecast.text}</span>
                        {forecast.detail && <small>{forecast.detail}</small>}
                      </p>
                    </div>
                  );
                })}
                {quota.message && <p className="usage-quota-message">{quota.message}</p>}
              </article>
            ))}
          </div>
        ) : (
          <div className="usage-empty">No agent activity in this period.</div>
        )}
        <div className="usage-index-status">
          <span>
            Automatically tracking {formatExact(installedCount)} detected agent
            {installedCount === 1 ? "" : "s"}
          </span>
          <span className="usage-scan-note">
            {formatExact(snapshot.scan.files_seen)} files indexed
            {snapshot.scan.files_read > 0
              ? ` · ${formatExact(snapshot.scan.files_read)} re-read (${formatBytes(snapshot.scan.bytes_read)})`
              : " · nothing changed"}{" "}
            · {snapshot.scan.duration_ms} ms
          </span>
        </div>
      </section>
    </>
  );
}
