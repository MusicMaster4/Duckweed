import { createRoot } from "react-dom/client";

import { restoreDurableStorage } from "./lib/durableStorage";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

// Native context menu and browser-style gestures do not belong in a terminal.
document.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("dragstart", (e) => e.preventDefault());

async function start() {
  const preview =
    import.meta.env.DEV && new URLSearchParams(window.location.search).has("agent-preview");
  if (preview) {
    const { AgentExperiencePreview } = await import(
      "./components/agent/AgentExperiencePreview"
    );
    const container = document.getElementById("root");
    if (!container) throw new Error("missing #root");
    createRoot(container).render(<AgentExperiencePreview />);
    return;
  }

  // Do this before importing App: command history and settings are read during
  // module initialization, so recovery must finish first after an update.
  await restoreDurableStorage();
  const { default: App } = await import("./App");
  const container = document.getElementById("root");
  if (!container) throw new Error("missing #root");

  // Deliberately not wrapped in StrictMode: its double-mount would spawn two
  // shells per pane in development.
  createRoot(container).render(<App />);
}

void start();
