import { useEffect, useRef } from "react";

import type { AgentPermission as Permission } from "../../lib/agents/types";
import { AgentDiff } from "./AgentDiff";

interface Props {
  permission: Permission;
  onRespond: (optionId: string) => void;
}

/**
 * The one place the session stops and waits for the user.
 *
 * The affirmative button is not autofocused: a prompt that appears while
 * someone is typing must not be one stray Enter away from approving a command
 * they never read. Escape picks the safest option instead.
 */
export function AgentPermission({ permission, onRespond }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const reject = permission.options.find(
    (option) => option.kind === "reject" || option.kind === "reject-always",
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !reject) return;
      event.preventDefault();
      event.stopPropagation();
      onRespond(reject.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [reject, onRespond]);

  useEffect(() => {
    cardRef.current?.scrollIntoView({ block: "nearest" });
  }, [permission.id]);

  return (
    <div className="agent-permission" ref={cardRef} role="alertdialog" aria-label="Permission required">
      <div className="agent-permission-head">
        <span className="agent-permission-mark" aria-hidden="true">
          !
        </span>
        <strong>{permission.title}</strong>
      </div>
      {permission.detail && <p className="agent-permission-detail">{permission.detail}</p>}
      {permission.command && <pre className="agent-permission-command">{permission.command}</pre>}
      {permission.changes.map((change, index) => (
        <AgentDiff key={`${change.path}-${index}`} change={change} />
      ))}
      <div className="agent-permission-actions">
        {permission.options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`agent-permission-btn is-${option.kind}`}
            onClick={() => onRespond(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
