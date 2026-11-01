import { useEffect, useRef, useState } from "react";
import type { AutomaticApprovalDuration } from "../lib/agents/automaticApproval";

export function AutomaticApprovalDialog({ onCancel, onConfirm }: {
  onCancel: () => void;
  onConfirm: (duration: AutomaticApprovalDuration) => void;
}) {
  const [duration, setDuration] = useState<AutomaticApprovalDuration>("1-hour");
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
      if (event.key === "Tab") {
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>("select, button");
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [onCancel]);

  return (
    <div className="approval-consent-backdrop" onPointerDown={onCancel}>
      <div className="approval-consent-dialog" ref={dialogRef} role="alertdialog"
        aria-modal="true" aria-labelledby="automatic-approval-title"
        aria-describedby="automatic-approval-body"
        onPointerDown={(event) => event.stopPropagation()}>
        <h2 id="automatic-approval-title">Automatically allow everything?</h2>
        <p id="automatic-approval-body">
          This is a dangerous option to have enabled. Duckweed will allow every agent
          permission request after 1 second, across all tabs. Agents may run destructive
          commands, change or delete files, or expose private data. Questions still need your answer.
        </p>
        <label className="settings-field automatic-approval-duration">
          <span><strong>Keep enabled</strong></span>
          <select value={duration} onChange={(event) => setDuration(event.target.value as AutomaticApprovalDuration)}>
            <option value="1-hour">For 1 hour</option>
            <option value="10-hours">For 10 hours</option>
            <option value="until-disabled">Until I turn it off</option>
          </select>
        </label>
        <div className="approval-consent-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="is-danger" onClick={() => onConfirm(duration)}>
            Enable automatic approvals
          </button>
        </div>
      </div>
    </div>
  );
}
