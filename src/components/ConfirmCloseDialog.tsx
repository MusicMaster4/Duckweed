import { useEffect, useSyncExternalStore } from "react";

import {
  answerConfirmClose,
  getConfirmClose,
  subscribeConfirmClose,
} from "../lib/confirmClose";

/**
 * Warp-style close confirmation: dark card, stacked full-width actions.
 * Mount once near the app root; it only renders when a prompt is pending.
 */
export function ConfirmCloseDialog() {
  const request = useSyncExternalStore(
    subscribeConfirmClose,
    getConfirmClose,
    getConfirmClose,
  );

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        answerConfirmClose(false);
      } else if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        answerConfirmClose(true);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [request]);

  if (!request) return null;

  return (
    <div
      className="confirm-backdrop"
      onPointerDown={() => answerConfirmClose(false)}
      role="presentation"
    >
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-close-title"
        aria-describedby="confirm-close-body"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-close-title" className="confirm-title">
          {request.title}
        </h2>
        <p id="confirm-close-body" className="confirm-message">
          {request.message}
        </p>
        <div className="confirm-actions">
          <button
            type="button"
            className="confirm-btn is-danger"
            autoFocus
            onClick={() => answerConfirmClose(true)}
          >
            {request.confirmLabel}
          </button>
          <button
            type="button"
            className="confirm-btn"
            onClick={() => answerConfirmClose(false)}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
