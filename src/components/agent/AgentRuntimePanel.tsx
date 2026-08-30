import { useMemo, useState } from "react";

import type { AgentSessionState } from "../../lib/agents/types";

interface Props {
  session: AgentSessionState;
  onRefreshExtensions: () => void;
  onRefreshTasks: () => void;
  onStopTask: (taskId: string) => void;
  onNative: () => void;
}

type Tab = "extensions" | "tasks" | "capabilities";

const EXTENSION_LABELS = {
  skill: "Skills",
  app: "Apps",
  plugin: "Plugins",
  mcp: "MCP servers",
  hook: "Hooks",
  workflow: "Workflows",
  agent: "Agents",
} as const;

export function AgentRuntimePanel({
  session,
  onRefreshExtensions,
  onRefreshTasks,
  onStopTask,
  onNative,
}: Props) {
  const [tab, setTab] = useState<Tab>("extensions");
  const groups = useMemo(() => {
    const result = new Map<string, NonNullable<AgentSessionState["extensions"]>>();
    for (const extension of session.extensions ?? []) {
      const group = result.get(extension.kind) ?? [];
      group.push(extension);
      result.set(extension.kind, group);
    }
    return [...result];
  }, [session.extensions]);
  const tasks = session.runtimeTasks ?? [];
  const busy = session.status === "working" || session.status === "waiting";
  const capabilities = session.capabilities;

  return (
    <section className="agent-runtime-panel" aria-label="Agent capabilities">
      <div className="agent-runtime-tabs" role="tablist">
        {(["extensions", "tasks", "capabilities"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "is-active" : ""}
            onClick={() => setTab(id)}
          >
            {id === "extensions" ? "Extensions" : id === "tasks" ? "Tasks" : "Support"}
            {id === "tasks" && tasks.some((task) => task.status === "running") && (
              <i>{tasks.filter((task) => task.status === "running").length}</i>
            )}
          </button>
        ))}
      </div>

      <div className="agent-runtime-body">
        {tab === "extensions" && (
          <>
            <div className="agent-runtime-section-head">
              <span>Provider extensions</span>
              <button type="button" onClick={onRefreshExtensions} disabled={session.extensionsLoading}>
                {session.extensionsLoading ? "Loading" : "Refresh"}
              </button>
            </div>
            {session.extensionsError && (
              <p className="agent-runtime-error">{session.extensionsError}</p>
            )}
            {groups.length === 0 && !session.extensionsLoading ? (
              <p className="agent-runtime-empty">No extensions were advertised yet.</p>
            ) : (
              groups.map(([kind, rows]) => (
                <div className="agent-runtime-group" key={kind}>
                  <h4>{EXTENSION_LABELS[kind as keyof typeof EXTENSION_LABELS] ?? kind}</h4>
                  {rows.map((extension) => (
                    <div className="agent-runtime-row" key={extension.id}>
                      <span className={`agent-runtime-status is-${extension.status ?? "ready"}`} />
                      <span className="agent-runtime-copy">
                        <strong>{extension.name}</strong>
                        <small>{extension.description || extension.source || "Available"}</small>
                      </span>
                      {extension.callable && (
                        <code>{extension.kind === "skill" ? `$${extension.name.replace(/^\//, "")}` : extension.kind === "app" ? `@${extension.name}` : extension.name}</code>
                      )}
                    </div>
                  ))}
                </div>
              ))
            )}
          </>
        )}

        {tab === "tasks" && (
          <>
            <div className="agent-runtime-section-head">
              <span>Background work</span>
              <button type="button" onClick={onRefreshTasks}>Refresh</button>
            </div>
            {tasks.length === 0 ? (
              <p className="agent-runtime-empty">No background tasks are visible.</p>
            ) : (
              tasks.map((task) => (
                <div className="agent-runtime-row" key={task.id}>
                  <span className={`agent-runtime-status is-${task.status}`} />
                  <span className="agent-runtime-copy">
                    <strong>{task.title}</strong>
                    <small>{task.detail || task.cwd || task.kind}</small>
                  </span>
                  {task.status === "running" && session.agent === "codex" && (
                    <button type="button" className="agent-runtime-stop" onClick={() => onStopTask(task.id)}>
                      Stop
                    </button>
                  )}
                </div>
              ))
            )}
          </>
        )}

        {tab === "capabilities" && (
          <>
            <div className="agent-runtime-section-head"><span>Negotiated support</span></div>
            {!capabilities ? (
              <p className="agent-runtime-empty">Waiting for the provider handshake.</p>
            ) : (
              <div className="agent-capability-grid">
                {Object.entries({ ...capabilities.inputs, ...capabilities.interactions, ...capabilities.extensions, ...capabilities.runtime }).map(([name, supported]) => (
                  <span key={name} className={supported ? "is-supported" : "is-unsupported"}>
                    {name.replace(/([a-z])([A-Z])/g, "$1 $2")}
                  </span>
                ))}
              </div>
            )}
            <div className="agent-native-fallback">
              <strong>Need a native-only feature?</strong>
              <p>Continue this conversation in the provider's terminal interface.</p>
              <button type="button" disabled={busy} onClick={onNative}>
                Open native interface
              </button>
              {busy && <small>Finish or stop the active turn first.</small>}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
