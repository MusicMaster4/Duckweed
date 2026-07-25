import { createRoot } from "react-dom/client";

import App from "./App";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

// Native context menu and browser-style gestures do not belong in a terminal.
document.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("dragstart", (e) => e.preventDefault());

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

// Deliberately not wrapped in StrictMode: its double-mount would spawn two
// shells per pane in development.
createRoot(container).render(<App />);
