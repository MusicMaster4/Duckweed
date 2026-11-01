import { autoApprovalOption } from "./autoApproval";
import type { AgentPermission } from "./types";

/** Absolute deadline survives restarts; null means disabled. */
export type AutomaticApproval = number | "until-disabled" | null;
export type AutomaticApprovalDuration = "1-hour" | "10-hours" | "until-disabled";
export const AUTOMATIC_APPROVAL_DELAY_MS = 1_000;

export function automaticApprovalSetting(value?: unknown, now = Date.now()): AutomaticApproval {
  if (value === "until-disabled") return value;
  return typeof value === "number" && Number.isFinite(value) && value > now ? value : null;
}

export function automaticApprovalDeadline(
  duration: AutomaticApprovalDuration,
  now = Date.now(),
): AutomaticApproval {
  if (duration === "until-disabled") return duration;
  return now + (duration === "10-hours" ? 10 : 1) * 60 * 60 * 1_000;
}

interface ApprovalSource {
  activeTermIds: () => string[];
  get: (termId: string) => { permission: AgentPermission | null } | null | undefined;
  subscribeAll: (callback: () => void) => () => void;
  respond: (termId: string, permissionId: string, optionId: string) => void;
}

interface ApprovalClock {
  now: () => number;
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout>) => void;
}

/** One timer per pending decision, across every tab, including hidden panes. */
export function startAutomaticApprovals(
  source: ApprovalSource,
  setting: () => AutomaticApproval,
  clock: ApprovalClock = { now: Date.now, schedule: setTimeout, cancel: clearTimeout },
): () => void {
  const pending = new Map<string, {
    permission: AgentPermission;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  const clear = (termId: string) => {
    const entry = pending.get(termId);
    if (entry?.timer != null) clock.cancel(entry.timer);
    pending.delete(termId);
  };
  const scan = () => {
    const active = new Set(source.activeTermIds());
    for (const termId of pending.keys()) {
      if (!active.has(termId)) clear(termId);
    }
    for (const termId of active) {
      const permission = source.get(termId)?.permission ?? null;
      const entry = pending.get(termId);
      if (entry && entry.permission !== permission) clear(termId);
      if (automaticApprovalSetting(setting(), clock.now()) === null || !autoApprovalOption(permission)) {
        clear(termId);
        continue;
      }
      if (!permission || pending.has(termId)) continue;
      const next = { permission, timer: null as ReturnType<typeof setTimeout> | null };
      pending.set(termId, next);
      next.timer = clock.schedule(() => {
        next.timer = null;
        // A manual response, expired deadline, or replaced prompt cancels approval.
        if (source.get(termId)?.permission !== permission ||
          automaticApprovalSetting(setting(), clock.now()) === null) return;
        const option = autoApprovalOption(permission);
        if (option) source.respond(termId, permission.id, option.id);
      }, AUTOMATIC_APPROVAL_DELAY_MS);
    }
  };
  const unsubscribe = source.subscribeAll(scan);
  scan();
  return () => {
    unsubscribe();
    for (const termId of pending.keys()) clear(termId);
  };
}
