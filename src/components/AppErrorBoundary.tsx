import { Component, type ErrorInfo, type ReactNode } from "react";
import { relaunch } from "@tauri-apps/plugin-process";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "The interface stopped unexpectedly.";
}

export function RecoveryScreen({ error }: { error: unknown }) {
  const restart = () => {
    void relaunch().catch(() => window.location.reload());
  };

  return (
    <main className="app-recovery" role="alert">
      <div className="app-recovery-card">
        <span className="app-recovery-mark" aria-hidden="true">DW</span>
        <div>
          <h1>Duckweed needs to recover</h1>
          <p>
            The interface stopped unexpectedly. Restart Duckweed to restore your
            workspace.
          </p>
        </div>
        <pre>{errorMessage(error)}</pre>
        <button type="button" onClick={restart}>Restart Duckweed</button>
      </div>
    </main>
  );
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Duckweed interface crashed", error, info.componentStack);
  }

  render() {
    if (this.state.error) return <RecoveryScreen error={this.state.error} />;
    return this.props.children;
  }
}
