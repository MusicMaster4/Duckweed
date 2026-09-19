/** Opt-in live test: bun scripts/grok-tools-smoke.ts (uses the signed-in Grok account). */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpAdapter } from "../src/lib/agents/adapters/acp";
import type { AdapterContext } from "../src/lib/agents/adapter";
import type { AgentLaunch } from "../src/lib/agents/launch";

const root = await mkdtemp(join(tmpdir(), "duckweed-grok-tools-"));
const cwd = join(root, "workspace");
await mkdir(cwd);
await writeFile(join(cwd, "notes.txt"), "FIRST_LINE\nNEEDLE_4821\nLAST_LINE\n");
await writeFile(join(root, "external-skill.md"), "EXTERNAL_SKILL_7319\n");
await writeFile(join(cwd, "large.txt"), "LARGE_FILE_5932\n" + "padding\n".repeat(750_000));
await copyFile(new URL("../assets/icon.png", import.meta.url), join(cwd, "reference.png"));
const launch: AgentLaunch = {
  agent: "grok", program: "grok", env: {}, wrapperArgs: [], forwardArgs: [], args: [],
  prompt: null, model: null, effort: null, resume: false, resumeId: null,
};
const adapter = createAcpAdapter("grok");
const proc = spawn(process.env.GROK_BIN ?? join(homedir(), ".grok/bin/grok.exe"),
  ["agent", "stdio"], { cwd, windowsHide: true, stdio: "pipe" });
let started = false;
let finished = false;
let clientFileCalls = 0;
let imageResult = false;
let assistant = "";
const tools = new Map<string, { name: string; status?: string }>();
let complete!: () => void;
let reject!: (error: Error) => void;
const done = new Promise<void>((resolve, fail) => { complete = resolve; reject = fail; });
const ctx: AdapterContext = {
  cwd, launch,
  send: (message) => proc.stdin.write(JSON.stringify(message) + "\n"),
  // Match the real UI: a service is present, but Grok must not delegate to it.
  files: {
    readText: async () => { clientFileCalls++; throw new Error("Unexpected client text read"); },
    writeText: async () => { clientFileCalls++; throw new Error("Unexpected client text write"); },
  },
  emit: (event) => {
    if (event.type === "tool") {
      const previous = tools.get(event.callId);
      tools.set(event.callId, { name: event.name ?? previous?.name ?? "tool",
        status: event.status ?? previous?.status });
      if (event.status === "done" || event.status === "error")
        console.log("TOOL", tools.get(event.callId));
    }
    if (event.type === "assistant-delta") assistant += event.text;
    if (event.type === "turn-end") { finished = true; complete(); }
    if (event.type === "permission" && event.permission) {
      const permission = event.permission;
      const option = permission.options.find((option) => option.kind === "allow");
      if (!option) reject(new Error("No allow-once permission option"));
      else adapter.respond(permission.id, option.id, ctx);
    }
    if (event.type === "status" && event.status === "error") reject(new Error("Agent failed"));
    if (event.type === "status" && event.status === "idle") {
      if (started) { finished = true; complete(); return; }
      started = true;
      adapter.prompt({ images: [], text: `Run this local integration test only in ${root}.
Use your native tools, not shell workarounds, for each file operation:
1. list_dir on the workspace.
2. read_file notes.txt and report its marker.
3. read_file reference.png and describe what you see.
4. read_file ${join(root, "external-skill.md")} and report its marker.
5. read_file large.txt with a limit of 2 lines and report its first line.
6. Search for NEEDLE_4821 in notes.txt using your search tool.
7. Create nested/result.txt containing SMOKE_CREATED with your write tool, then edit it to SMOKE_EDITED with your edit tool. Read it back.
8. Run a terminal command that prints SHELL_6248.
Do not change any other paths, delegate, install anything, or use network tools. Summarize results and markers.` }, ctx);
    }
  },
};
createInterface({ input: proc.stdout }).on("line", (line) => {
  try {
    const update = JSON.parse(line)?.params?.update;
    if (update?.content?.some?.((block: any) => (block.content ?? block).type === "image")) imageResult = true;
    adapter.receive(line, ctx);
  } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
});
proc.stderr.resume();
proc.on("error", reject);
proc.on("exit", (code) => { if (!finished) reject(new Error(`Grok exited: ${code}`)); });
const timeout = setTimeout(() => reject(new Error("Smoke test timed out after 4 minutes")), 240_000);
try {
  adapter.start(ctx);
  await done;
  if (clientFileCalls) throw new Error("Grok used the client text-only service");
  if (!imageResult) throw new Error("Native read_file did not return an image content block");
  if ([...tools.values()].some((tool) => tool.status === "error")) throw new Error("A tool failed");
  for (const marker of ["NEEDLE_4821", "EXTERNAL_SKILL_7319", "LARGE_FILE_5932", "SHELL_6248"])
    if (!assistant.includes(marker)) throw new Error(`Missing result marker: ${marker}`);
  if ((await readFile(join(cwd, "nested/result.txt"), "utf8")).trim() !== "SMOKE_EDITED")
    throw new Error("Native write/edit verification failed");
  console.log(JSON.stringify({ passed: true, clientFileCalls, imageResult, tools: [...tools.values()], assistant, fixtures: root }, null, 2));
} finally {
  clearTimeout(timeout);
  proc.kill();
}
