import { Meter } from "./UsageCharts";
import {
  agentColor,
  describeForecast,
  formatQuotaValue,
  quotaRemaining,
  untilReset,
  type Quota,
} from "../lib/usage";

/** The provider limits shown in both Usage settings and the statistics tool. */
export function QuotaCards({ quotas, now }: { quotas: Quota[]; now: number }) {
  return (
    <div className="usage-quota-grid">
      {quotas.map((quota) => (
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
  );
}
