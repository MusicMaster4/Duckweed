import {
  asArray,
  asRecord,
  asString,
  imagePayloadBase64,
  oneLine,
  parseJson,
  type AdapterContext,
  type AgentAdapter,
} from "../adapter";
import {
  goalAfterCommand,
  goalAfterProviderText,
  goalResponseFailed,
} from "../goal";
import type { AgentLaunch } from "../launch";
import {
  makeChange,
  toolKind,
  type AgentAccessMode,
  type AgentFileChange,
  type AgentGoal,
  type AgentPrompt,
  type AgentQuestionItem,
  type AgentPlanStep,
  type SubagentMeta,
  type ToolStatus,
} from "../types";

/**
 * Claude Code's `stream-json` mode.
 *
 * The CLI reads one Anthropic-shaped user message per line and writes back the
 * raw streaming events plus a few wrappers of its own. Two channels matter:
 * `stream_event` carries the partial deltas that make the UI feel live, and
 * the `assistant` / `user` messages carry the settled version of the same
 * content — tool inputs arrive complete there, which is where titles and diffs
 * come from. Permission prompts ride the control protocol on the same stream,
 * and so do the questions Claude asks the user (see {@link QUESTION_TOOL}).
 *
 * Slash commands are plain user messages: the CLI intercepts leading-`/`
 * text itself, answers with a synthetic assistant message (`model` is the
 * literal string `"<synthetic>"`), and closes with a `result` frame — no
 * model tokens involved (verified against claude 2.1). The one exception is
 * `/model <id>`, which we route through the `set_model` control request so
 * the header learns the new model from a structured ACK rather than by
 * parsing the CLI's friendly confirmation sentence.
 */

interface ToolCall {
  name: string;
  /** Accumulated `input_json_delta` text, parsed once the block closes. */
  partialInput: string;
}

interface TrackedTask {
  id: string;
  text: string;
  status: AgentPlanStep["status"];
}

interface TrackedWorkflow {
  callId: string;
  taskId: string | null;
  name: string;
  summary: string;
  phases: string[];
  status: "launching" | "running" | "completed" | "failed" | "stopped";
}

const CLAUDE_TASK_TOOLS = new Set([
  "taskcreate",
  "taskupdate",
  "tasklist",
  "taskget",
]);

function isClaudeTaskTool(name: string): boolean {
  return CLAUDE_TASK_TOOLS.has(name.toLowerCase());
}

function taskStatus(value: unknown): AgentPlanStep["status"] {
  const status = asString(value)?.toLowerCase();
  if (status === "completed" || status === "done") return "done";
  if (status === "in_progress" || status === "running") return "running";
  return "pending";
}

function parseTaskList(output: string): TrackedTask[] | null {
  if (/^\s*No tasks found\s*$/i.test(output)) return [];
  const tasks: TrackedTask[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*#(\S+)\s+\[([^\]]+)\]\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    tasks.push({
      id: match[1],
      text: match[3],
      status: taskStatus(match[2]),
    });
  }
  return tasks.length ? tasks : null;
}

function parseTaskGet(output: string): TrackedTask | null {
  const heading = /^\s*Task #(\S+):\s*(.+?)\s*$/m.exec(output);
  const status = /^\s*Status:\s*(.+?)\s*$/m.exec(output);
  if (!heading) return null;
  return {
    id: heading[1],
    text: heading[2],
    status: taskStatus(status?.[1]),
  };
}

function batchTasks(input: Record<string, unknown>): Array<{
  text: string;
  status: AgentPlanStep["status"];
}> {
  const raw = input.tasks;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return asArray(parsed)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      text:
        asString(entry.subject)?.trim() ??
        asString(entry.content)?.trim() ??
        asString(entry.description)?.trim() ??
        "",
      status: taskStatus(entry.status),
    }))
    .filter((entry) => entry.text);
}

function decodedJsString(value: string): string {
  return value
    .replace(/\\(['"`\\])/g, "$1")
    .replace(/\\n/g, " ")
    .trim();
}

/**
 * Dynamic workflows carry their display metadata in the JavaScript passed to
 * the Workflow tool. Read only the small `meta` prelude, never evaluate it.
 */
function workflowMeta(input: Record<string, unknown>): {
  name: string;
  summary: string;
  phases: string[];
} {
  const script = asString(input.script) ?? "";
  const metaStart = script.search(/\bexport\s+const\s+meta\s*=/);
  const afterMeta = metaStart >= 0 ? script.slice(metaStart) : script;
  const metaEnd = afterMeta.search(/\n\s*}\s*\n/);
  const meta = metaEnd >= 0 ? afterMeta.slice(0, metaEnd + 2) : afterMeta.slice(0, 8_000);
  const capture = (key: string): string => {
    const match = new RegExp(`\\b${key}\\s*:\\s*(['"\`])([\\s\\S]*?)\\1`).exec(meta);
    return match ? decodedJsString(match[2]) : "";
  };
  const phases = [
    ...meta.matchAll(/\btitle\s*:\s*(['"`])([\s\S]*?)\1/g),
  ]
    .map((match) => decodedJsString(match[2]))
    .filter(Boolean);

  // Older scripts may omit `meta.phases` but still call phase("...").
  if (!phases.length) {
    for (const match of script.matchAll(/\bphase\s*\(\s*(['"`])([\s\S]*?)\1\s*\)/g)) {
      const title = decodedJsString(match[2]);
      if (title && !phases.includes(title)) phases.push(title);
    }
  }

  return {
    name: capture("name") || "Workflow",
    summary: capture("description"),
    phases,
  };
}

function workflowSteps(
  workflow: TrackedWorkflow,
  status: "running" | "completed",
): AgentPlanStep[] {
  const phases = workflow.phases.length ? workflow.phases : [workflow.summary || workflow.name];
  return phases.map((text, index) => ({
    text,
    status:
      status === "completed"
        ? ("done" as const)
        : index === 0
          ? ("running" as const)
          : ("pending" as const),
  }));
}

function workflowLaunch(
  frame: Record<string, unknown>,
  output: string,
): {
  taskId: string;
  name: string;
  summary: string;
} | null {
  const result =
    asRecord(frame.toolUseResult) ??
    asRecord(frame.tool_use_result) ??
    asRecord(frame.tool_result);
  const status = asString(result?.status);
  const taskType = asString(result?.taskType) ?? asString(result?.task_type);
  const launched =
    status === "async_launched" ||
    taskType === "local_workflow" ||
    /Workflow launched in background/i.test(output);
  if (!launched) return null;
  const taskId =
    asString(result?.taskId) ??
    asString(result?.task_id) ??
    /Task ID:\s*(\S+)/i.exec(output)?.[1] ??
    "";
  if (!taskId) return null;
  return {
    taskId,
    name:
      asString(result?.workflowName) ??
      asString(result?.workflow_name) ??
      "",
    summary: asString(result?.summary) ?? "",
  };
}

function taskNotification(text: string): {
  taskId: string;
  status: "completed" | "failed" | "stopped";
  summary: string;
} | null {
  if (!text.includes("<task-notification>")) return null;
  const taskId = /<task-id>([^<]+)<\/task-id>/i.exec(text)?.[1]?.trim() ?? "";
  const rawStatus = /<status>([^<]+)<\/status>/i.exec(text)?.[1]?.trim().toLowerCase();
  if (
    !taskId ||
    (rawStatus !== "completed" && rawStatus !== "failed" && rawStatus !== "stopped")
  ) {
    return null;
  }
  return {
    taskId,
    status: rawStatus,
    summary: /<summary>([\s\S]*?)<\/summary>/i.exec(text)?.[1]?.trim() ?? "",
  };
}

/**
 * `AskUserQuestion` is Claude asking the user to decide something, not a tool
 * that needs approving.
 *
 * The CLI routes it through the same `can_use_tool` channel as every other
 * call, and expects the client's permission UI to collect the choices and hand
 * them back on the allowed input. Answering it with a bare "Allow" is what
 * makes the prompt look like it does nothing: the tool runs with no answers in
 * it and Claude learns nothing.
 */
const QUESTION_TOOL = "askuserquestion";

/** Turn a tool's input into the one line that names the call. */
function describeTool(name: string, input: Record<string, unknown>): string {
  // A question reads as the question, not as the name of the tool carrying it.
  if (name.toLowerCase() === QUESTION_TOOL) {
    const questions = asArray(input.questions)
      .map((raw) => asRecord(raw))
      .map((question) => asString(question?.question))
      .filter((text): text is string => text !== null && text.trim() !== "");
    if (questions.length === 1) return oneLine(questions[0]);
    if (questions.length > 1) return `${questions.length} questions for you`;
    return "A question for you";
  }
  const first = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return null;
  };
  if (toolKind(name) === "task") {
    const label = first("description", "subagent_type", "name", "prompt");
    return label ? oneLine(label) : "Subagent";
  }
  if (isClaudeTaskTool(name)) {
    const lower = name.toLowerCase();
    if (lower === "taskcreate") {
      const subject = asString(input.subject)?.trim();
      return subject ? `Create task: ${oneLine(subject)}` : "Create tasks";
    }
    if (lower === "taskupdate") {
      const id = asString(input.taskId)?.trim();
      const status = asString(input.status)?.trim();
      return id
        ? `Update task #${id}${status ? `: ${status.replaceAll("_", " ")}` : ""}`
        : "Update task";
    }
    if (lower === "taskget") {
      const id = asString(input.taskId)?.trim();
      return id ? `Read task #${id}` : "Read task";
    }
    return "Check task list";
  }
  if (name.toLowerCase() === "workflow") {
    const meta = workflowMeta(input);
    return meta.name === "Workflow" ? meta.name : `Workflow · ${meta.name}`;
  }
  const detail =
    first("command", "file_path", "path", "pattern", "query", "url", "description", "prompt") ??
    "";
  return detail ? `${name} · ${oneLine(detail)}` : name;
}

function subagentForTool(
  name: string,
  input: Record<string, unknown>,
): SubagentMeta | undefined {
  if (toolKind(name) !== "task") return undefined;
  const description = asString(input.description)?.trim();
  const role = asString(input.subagent_type)?.trim();
  const prompt = asString(input.prompt)?.trim();
  const label = description || role || asString(input.name)?.trim() || prompt;
  const model = asString(input.model)?.trim();
  const parentCallId = asString(input.parent_tool_use_id)?.trim();
  return {
    ...(label ? { label: oneLine(label, 80) } : {}),
    ...(role ? { role } : {}),
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    ...(parentCallId ? { parentCallId } : {}),
  };
}

/** File edits a tool call is making, as far as its input reveals them. */
function changesFor(name: string, input: Record<string, unknown>): AgentFileChange[] {
  const path = asString(input.file_path) ?? asString(input.path);
  if (!path) return [];
  const lower = name.toLowerCase();

  if (lower === "write") {
    return [makeChange(path, null, asString(input.content) ?? "")];
  }
  if (lower === "edit") {
    const before = asString(input.old_string);
    const after = asString(input.new_string);
    if (before === null && after === null) return [];
    return [makeChange(path, before, after)];
  }
  if (lower === "multiedit") {
    return asArray(input.edits)
      .map((raw) => asRecord(raw))
      .filter((edit): edit is Record<string, unknown> => edit !== null)
      .map((edit) => makeChange(path, asString(edit.old_string), asString(edit.new_string)));
  }
  return [];
}

/** Read the questions out of an `AskUserQuestion` input. */
function questionsFrom(input: Record<string, unknown>): AgentQuestionItem[] {
  return asArray(input.questions)
    .map((raw) => asRecord(raw))
    .filter((question): question is Record<string, unknown> => question !== null)
    .map((question, index) => ({
      id: `q${index}`,
      header: asString(question.header) ?? "",
      question: asString(question.question) ?? "",
      multiSelect: question.multiSelect === true,
      options: asArray(question.options)
        .map((raw) => asRecord(raw))
        .filter((option): option is Record<string, unknown> => option !== null)
        .map((option, optionIndex) => ({
          id: `o${optionIndex}`,
          label: asString(option.label) ?? `Option ${optionIndex + 1}`,
          description: asString(option.description) ?? "",
          preview: asString(option.preview),
        }))
        .filter((option) => option.label),
    }))
    .filter((question) => question.question && question.options.length > 0);
}

/** `TodoWrite` is Claude's plan; lift it out of the tool list into the plan row. */
function planFrom(input: Record<string, unknown>) {
  return asArray(input.todos)
    .map((raw) => asRecord(raw))
    .filter((todo): todo is Record<string, unknown> => todo !== null)
    .map((todo) => ({
      text: asString(todo.content) ?? asString(todo.activeForm) ?? "",
      status:
        todo.status === "completed"
          ? ("done" as const)
          : todo.status === "in_progress"
            ? ("running" as const)
            : ("pending" as const),
    }))
    .filter((step) => step.text);
}

/** Tool results arrive as text, or as blocks that each hold some. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return asArray(content)
    .map((raw) => {
      const block = asRecord(raw);
      if (!block) return "";
      return asString(block.text) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

export function createClaudeAdapter(): AgentAdapter {
  /** Content-block index → the item id the deltas belong to. */
  const blocks = new Map<number, { kind: "text" | "thinking" | "tool"; id: string }>();
  const tools = new Map<string, ToolCall>();
  const nestedTools = new Map<
    string,
    {
      name: string;
      title: string;
      command: string | null;
      changes: AgentFileChange[];
    }
  >();
  /** Claude's current task list, independently tracked for the parent and each child. */
  const taskScopes = new Map<string, Map<string, TrackedTask>>();
  /** Provisional rows created before TaskCreate returns the provider task id. */
  const taskCreateKeys = new Map<string, string[]>();
  /** Optimistic TaskUpdate snapshots, restored if Claude reports an error. */
  const taskUpdateUndo = new Map<string, { scope: string; tasks: Map<string, TrackedTask> }>();
  /** Background dynamic workflows remain running after their launch tool returns. */
  const workflowsByCallId = new Map<string, TrackedWorkflow>();
  const workflowCallByTaskId = new Map<string, string>();
  let latestWorkflowCallId: string | null = null;
  let messageSeq = 0;
  let settledMessageSeq = 0;
  let controlSeq = 0;
  /** Control request ids Claude is waiting on, keyed by our permission id. */
  const pendingPermissions = new Map<
    string,
    {
      requestId: string;
      input: Record<string, unknown>;
      /** Set for `AskUserQuestion`, so answers can be mapped back to it. */
      questions: AgentQuestionItem[] | null;
    }
  >();
  /** Our outbound `set_model` requests, keyed by the id we gave them. */
  const pendingModelChanges = new Map<string, string>();
  /** Our outbound `set_permission_mode` requests, keyed by request id. */
  const pendingAccessChanges = new Map<
    string,
    { mode: AgentAccessMode; announce: boolean }
  >();
  /**
   * Claude can report one API failure through several protocol frames: a
   * synthetic assistant message, a forwarded child-agent message, and the
   * final result. Keep one visible error for the submitted turn.
   */
  const seenTurnErrors = new Set<string>();
  let currentGoal: AgentGoal | null = null;
  let goalBeforeCommand: AgentGoal | null = null;
  let goalResponsePending = false;

  const blockId = (index: number) => `m${messageSeq}-b${index}`;
  const ROOT_TASK_SCOPE = "";

  function tasksFor(scope: string): Map<string, TrackedTask> {
    let tasks = taskScopes.get(scope);
    if (!tasks) {
      tasks = new Map();
      taskScopes.set(scope, tasks);
    }
    return tasks;
  }

  function emitTaskPlan(scope: string, ctx: AdapterContext): void {
    const steps = [...tasksFor(scope).values()].map(({ text, status }) => ({
      text,
      status,
    }));
    if (scope === ROOT_TASK_SCOPE) {
      ctx.emit({ type: "plan", steps });
      return;
    }
    ctx.emit({
      type: "tool",
      callId: scope,
      subagentItem: {
        kind: "plan",
        id: `child-plan-${scope}`,
        at: Date.now(),
        steps,
      },
    });
  }

  function replaceTaskId(
    tasks: Map<string, TrackedTask>,
    oldId: string,
    task: TrackedTask,
  ): void {
    const replaced = new Map<string, TrackedTask>();
    let found = false;
    for (const [id, current] of tasks) {
      if (id === oldId) {
        replaced.set(task.id, task);
        found = true;
      } else {
        replaced.set(id, current);
      }
    }
    if (!found) replaced.set(task.id, task);
    tasks.clear();
    for (const [id, current] of replaced) tasks.set(id, current);
  }

  function trackTaskUse(
    scope: string,
    callId: string,
    name: string,
    input: Record<string, unknown>,
    ctx: AdapterContext,
  ): void {
    const lower = name.toLowerCase();
    if (!CLAUDE_TASK_TOOLS.has(lower)) return;
    const tasks = tasksFor(scope);

    if (lower === "taskcreate") {
      const entries = batchTasks(input);
      const subject = asString(input.subject)?.trim();
      if (subject) entries.unshift({ text: subject, status: "pending" });
      if (!entries.length) return;
      const keys = entries.map((entry, index) => {
        const key = `create:${callId}:${index}`;
        tasks.set(key, { id: key, ...entry });
        return key;
      });
      taskCreateKeys.set(callId, keys);
      emitTaskPlan(scope, ctx);
      return;
    }

    if (lower !== "taskupdate") return;
    const id = asString(input.taskId)?.trim();
    const rawStatus = asString(input.status)?.toLowerCase();
    if (!id || (!rawStatus && !tasks.has(id))) return;
    if (!taskUpdateUndo.has(callId)) {
      taskUpdateUndo.set(callId, { scope, tasks: new Map(tasks) });
    }
    if (rawStatus === "deleted") {
      tasks.delete(id);
    } else {
      const current = tasks.get(id);
      tasks.set(id, {
        id,
        text:
          current?.text ??
          asString(input.activeForm)?.trim() ??
          `Task #${id}`,
        status: rawStatus ? taskStatus(rawStatus) : current?.status ?? "pending",
      });
    }
    emitTaskPlan(scope, ctx);
  }

  function trackTaskResult(
    scope: string,
    callId: string,
    name: string,
    output: string,
    failed: boolean,
    ctx: AdapterContext,
  ): void {
    const lower = name.toLowerCase();
    if (!CLAUDE_TASK_TOOLS.has(lower)) return;
    const tasks = tasksFor(scope);

    if (lower === "taskcreate") {
      const keys = taskCreateKeys.get(callId) ?? [];
      taskCreateKeys.delete(callId);
      if (failed) {
        for (const key of keys) tasks.delete(key);
        emitTaskPlan(scope, ctx);
        return;
      }
      const created = [
        ...output.matchAll(/Task #(\S+) created successfully:\s*(.+?)(?:\r?\n|$)/gi),
      ];
      for (const [index, match] of created.entries()) {
        const oldId = keys[index];
        if (!oldId) break;
        const current = tasks.get(oldId);
        replaceTaskId(tasks, oldId, {
          id: match[1],
          text: match[2].trim() || current?.text || `Task #${match[1]}`,
          status: current?.status ?? "pending",
        });
      }
      emitTaskPlan(scope, ctx);
      return;
    }

    if (lower === "taskupdate") {
      const undo = taskUpdateUndo.get(callId);
      taskUpdateUndo.delete(callId);
      if (failed && undo) {
        taskScopes.set(undo.scope, new Map(undo.tasks));
        emitTaskPlan(undo.scope, ctx);
      }
      return;
    }

    if (failed) return;
    if (lower === "tasklist") {
      const listed = parseTaskList(output);
      if (listed === null) return;
      taskScopes.set(scope, new Map(listed.map((task) => [task.id, task])));
      emitTaskPlan(scope, ctx);
      return;
    }
    if (lower === "taskget") {
      const task = parseTaskGet(output);
      if (!task) return;
      tasks.set(task.id, task);
      emitTaskPlan(scope, ctx);
    }
  }

  function emitTurnError(text: string, ctx: AdapterContext) {
    if (seenTurnErrors.has(text)) return;
    seenTurnErrors.add(text);
    ctx.emit({ type: "notice", tone: "error", text });
  }

  /** Apply a settled tool input: title, command, diffs, and plans. */
  function settleTool(callId: string, name: string, input: Record<string, unknown>, ctx: AdapterContext) {
    if (name.toLowerCase() === "todowrite") {
      const steps = planFrom(input);
      if (steps.length) ctx.emit({ type: "plan", steps });
    }
    if (name.toLowerCase() === "workflow") {
      const meta = workflowMeta(input);
      const workflow: TrackedWorkflow = {
        callId,
        taskId: null,
        name: meta.name,
        summary: meta.summary,
        phases: meta.phases,
        status: "launching",
      };
      workflowsByCallId.set(callId, workflow);
      latestWorkflowCallId = callId;
      ctx.emit({ type: "plan", steps: workflowSteps(workflow, "running") });
    }
    trackTaskUse(ROOT_TASK_SCOPE, callId, name, input, ctx);
    const subagent = subagentForTool(name, input);
    ctx.emit({
      type: "tool",
      callId,
      name,
      tool: toolKind(name),
      title: describeTool(name, input),
      command: asString(input.command),
      changes: changesFor(name, input),
      ...(subagent ? { subagent } : {}),
    });
  }

  function handleStreamEvent(event: Record<string, unknown>, ctx: AdapterContext) {
    const type = asString(event.type);

    if (type === "message_start") {
      messageSeq += 1;
      blocks.clear();
      ctx.emit({ type: "status", status: "working" });
      return;
    }

    if (type === "content_block_start") {
      const index = typeof event.index === "number" ? event.index : 0;
      const block = asRecord(event.content_block);
      const blockType = asString(block?.type);
      if (blockType === "thinking" || blockType === "redacted_thinking") {
        blocks.set(index, { kind: "thinking", id: blockId(index) });
      } else if (blockType === "text") {
        blocks.set(index, { kind: "text", id: blockId(index) });
      } else if (blockType === "tool_use" && block) {
        const callId = asString(block.id) ?? blockId(index);
        const name = asString(block.name) ?? "tool";
        blocks.set(index, { kind: "tool", id: callId });
        tools.set(callId, { name, partialInput: "" });
        ctx.emit({
          type: "tool",
          callId,
          name,
          tool: toolKind(name),
          title: name,
          status: "running",
        });
      }
      return;
    }

    if (type === "content_block_delta") {
      const index = typeof event.index === "number" ? event.index : 0;
      const target = blocks.get(index);
      if (!target) return;
      const delta = asRecord(event.delta);
      const deltaType = asString(delta?.type);
      if (deltaType === "thinking_delta") {
        const text = asString(delta?.thinking);
        if (text) ctx.emit({ type: "thinking-delta", id: target.id, text });
      } else if (deltaType === "text_delta") {
        const text = asString(delta?.text);
        if (text) ctx.emit({ type: "assistant-delta", id: target.id, text });
      } else if (deltaType === "input_json_delta") {
        const call = tools.get(target.id);
        const fragment = asString(delta?.partial_json);
        if (call && fragment) call.partialInput += fragment;
      }
      return;
    }

    if (type === "content_block_stop") {
      const index = typeof event.index === "number" ? event.index : 0;
      const target = blocks.get(index);
      if (!target) return;
      if (target.kind === "thinking") ctx.emit({ type: "thinking-end", id: target.id });
      if (target.kind === "text") ctx.emit({ type: "assistant-end", id: target.id });
      if (target.kind === "tool") {
        // The settled `assistant` message also carries this input, but it can
        // land after the tool has already started running. Parsing the streamed
        // fragments means the title appears the moment the call is made.
        const call = tools.get(target.id);
        if (call?.partialInput) {
          const input = asRecord(parseJson(call.partialInput));
          if (input) settleTool(target.id, call.name, input, ctx);
        }
      }
      return;
    }

    if (type === "message_delta") {
      const usage = asRecord(event.usage);
      if (usage) emitUsage(usage, ctx);
    }
  }

  function emitUsage(usage: Record<string, unknown>, ctx: AdapterContext) {
    const number = (value: unknown) => (typeof value === "number" ? value : 0);
    ctx.emit({
      type: "usage",
      usage: {
        inputTokens:
          number(usage.input_tokens) +
          number(usage.cache_creation_input_tokens) +
          number(usage.cache_read_input_tokens),
        outputTokens: number(usage.output_tokens),
      },
    });
  }

  /** The settled assistant message: authoritative tool inputs and text. */
  function handleAssistant(
    message: Record<string, unknown>,
    frame: Record<string, unknown>,
    ctx: AdapterContext,
  ) {
    // Slash command answers arrive as a synthetic assistant message — "Set
    // effort level to high (this session only)", "Unknown command: /foo".
    // That feedback is the whole point of the command, so it must render.
    if (asString(message.model) === "<synthetic>") {
      const text = asArray(message.content)
        .map((raw) => asRecord(raw))
        .filter((block): block is Record<string, unknown> => block !== null)
        .map((block) => asString(block.text) ?? "")
        .filter(Boolean)
        .join("\n")
        .trim();
      if (text) {
        if (goalResponsePending) {
          const goal = goalAfterProviderText(currentGoal, text);
          if (goal !== undefined) {
            currentGoal = goal;
            ctx.emit({ type: "goal", goal });
          } else if (goalResponseFailed(text)) {
            currentGoal = goalBeforeCommand;
            ctx.emit({ type: "goal", goal: currentGoal });
          }
          goalResponsePending = false;
        }
        // Keep the header in sync when the CLI confirms an effort change
        // (or refuses ultracode / a bad level).
        const setEffort = /Set effort level to (\w+)/i.exec(text);
        if (setEffort) {
          const effort = setEffort[1].toLowerCase();
          ctx.emit({ type: "session", effort });
          ctx.emit({ type: "notice", tone: "info", text: `Effort set to ${effort}.` });
          return;
        }
        const failed =
          asString(frame.error) !== null ||
          frame.is_api_error_message === true ||
          frame.isApiErrorMessage === true;
        const refused =
          goalResponseFailed(text) ||
          /needs dynamic workflows|Invalid argument|Valid options are/i.test(text);
        if (failed) emitTurnError(text, ctx);
        else ctx.emit({ type: "notice", tone: refused ? "error" : "info", text });
      }
      return;
    }
    if (goalResponsePending) {
      const responseText = asArray(message.content)
        .map((raw) => asRecord(raw))
        .filter((block): block is Record<string, unknown> => block !== null)
        .filter((block) => asString(block.type) === "text")
        .map((block) => asString(block.text) ?? "")
        .filter(Boolean)
        .join("\n")
        .trim();
      if (responseText) {
        const goal = goalAfterProviderText(currentGoal, responseText);
        if (goal !== undefined) {
          currentGoal = goal;
          ctx.emit({ type: "goal", goal });
        } else if (goalResponseFailed(responseText)) {
          currentGoal = goalBeforeCommand;
          ctx.emit({ type: "goal", goal: currentGoal });
        }
        goalResponsePending = false;
      }
    }
    const fallbackMessageId =
      asString(message.id) ?? `settled-${++settledMessageSeq}`;
    // The settled message can omit thinking blocks that were present in the
    // raw stream. Match text by its ordinal among text blocks, not by the
    // absolute content index, so the authoritative copy updates the streamed
    // item instead of creating a duplicate beside it.
    const streamedTextBlocks = [...blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => block)
      .filter((block) => block.kind === "text");
    let textIndex = 0;
    for (const [index, raw] of asArray(message.content).entries()) {
      const block = asRecord(raw);
      if (!block) continue;
      const blockType = asString(block.type);
      if (blockType === "text") {
        const text = asString(block.text);
        if (!text) continue;
        const streamed = streamedTextBlocks[textIndex];
        textIndex += 1;
        const id = streamed?.id ?? `${fallbackMessageId}-b${index}`;
        ctx.emit({ type: "assistant-snapshot", id, text });
        continue;
      }
      if (blockType !== "tool_use") continue;
      const callId = asString(block.id);
      const name = asString(block.name) ?? "tool";
      const input = asRecord(block.input) ?? {};
      if (!callId) continue;
      tools.set(callId, { name, partialInput: "" });
      settleTool(callId, name, input, ctx);
    }
  }

  function handleSubagentAssistant(
    message: Record<string, unknown>,
    parentCallId: string,
    ctx: AdapterContext,
  ) {
    const messageId =
      asString(message.id) ?? `child-${parentCallId}-${++settledMessageSeq}`;
    for (const [index, raw] of asArray(message.content).entries()) {
      const block = asRecord(raw);
      if (!block) continue;
      const blockType = asString(block.type);
      if (blockType === "text") {
        const text = asString(block.text)?.trim();
        if (!text) continue;
        ctx.emit({
          type: "tool",
          callId: parentCallId,
          subagent: { activity: oneLine(text.split(/\r?\n/).filter(Boolean).at(-1) ?? text) },
          subagentItem: {
            kind: "assistant",
            id: `child-${parentCallId}-${messageId}-b${index}`,
            at: Date.now(),
            text,
            streaming: false,
          },
        });
        continue;
      }
      if (blockType !== "tool_use") continue;
      const callId = asString(block.id);
      if (!callId) continue;
      const name = asString(block.name) ?? "tool";
      const input = asRecord(block.input) ?? {};
      const title = describeTool(name, input);
      const command = asString(input.command);
      const changes = changesFor(name, input);
      const subagent = subagentForTool(name, input);
      nestedTools.set(callId, { name, title, command, changes });
      trackTaskUse(parentCallId, callId, name, input, ctx);
      ctx.emit({
        type: "tool",
        callId: parentCallId,
        subagent: { activity: `Using ${oneLine(title, 100)}` },
        subagentItem: {
          kind: "tool",
          id: `child-tool-${callId}`,
          at: Date.now(),
          callId,
          name,
          tool: toolKind(name),
          title,
          status: "running",
          command,
          output: "",
          changes,
          ...(subagent ? { subagent } : {}),
        },
      });
    }
  }

  function handleSubagentToolResults(
    message: Record<string, unknown>,
    parentCallId: string,
    ctx: AdapterContext,
  ) {
    for (const raw of asArray(message.content)) {
      const block = asRecord(raw);
      if (!block || asString(block.type) !== "tool_result") continue;
      const callId = asString(block.tool_use_id);
      if (!callId) continue;
      const failed = block.is_error === true;
      const known = nestedTools.get(callId);
      const output = resultText(block.content);
      const name = known?.name ?? "tool";
      const title = known?.title ?? name;
      trackTaskResult(
        parentCallId,
        callId,
        name,
        output,
        failed,
        ctx,
      );
      ctx.emit({
        type: "tool",
        callId: parentCallId,
        subagent: {
          activity: failed
            ? `Failed: ${oneLine(title, 100)}`
            : output.trim()
              ? oneLine(output.split(/\r?\n/).filter(Boolean).at(-1) ?? output)
              : `Completed ${oneLine(title, 100)}`,
        },
        subagentItem: {
          kind: "tool",
          id: `child-tool-${callId}`,
          at: Date.now(),
          callId,
          name,
          tool: toolKind(name),
          title,
          status: failed ? "error" : "done",
          command: known?.command ?? null,
          output,
          changes: known?.changes ?? [],
        },
      });
      nestedTools.delete(callId);
    }
  }

  /** Tool results come back wrapped in a synthetic user message. */
  function handleToolResults(
    message: Record<string, unknown>,
    frame: Record<string, unknown>,
    ctx: AdapterContext,
  ) {
    for (const raw of asArray(message.content)) {
      const block = asRecord(raw);
      if (!block || asString(block.type) !== "tool_result") continue;
      const callId = asString(block.tool_use_id);
      if (!callId) continue;
      const failed = block.is_error === true;
      const known = tools.get(callId);
      const output = resultText(block.content);
      const workflow = workflowsByCallId.get(callId);
      const launch = workflow ? workflowLaunch(frame, output) : null;
      if (workflow && launch && !failed) {
        workflow.taskId = launch.taskId;
        if (launch.name) workflow.name = launch.name;
        if (launch.summary) workflow.summary = launch.summary;
        workflow.status = "running";
        workflowCallByTaskId.set(launch.taskId, callId);
        ctx.emit({
          type: "tool",
          callId,
          status: "running",
          title:
            workflow.name === "Workflow"
              ? workflow.name
              : `Workflow · ${workflow.name}`,
          output,
        });
        if (latestWorkflowCallId === callId) {
          ctx.emit({ type: "plan", steps: workflowSteps(workflow, "running") });
        }
        continue;
      }
      trackTaskResult(
        ROOT_TASK_SCOPE,
        callId,
        known?.name ?? "tool",
        output,
        failed,
        ctx,
      );
      ctx.emit({
        type: "tool",
        callId,
        status: failed ? ("error" as ToolStatus) : ("done" as ToolStatus),
        output,
      });
    }
  }

  function handleTaskNotification(text: string, ctx: AdapterContext): void {
    const notification = taskNotification(text);
    if (!notification) return;
    const callId = workflowCallByTaskId.get(notification.taskId);
    if (!callId) return;
    const workflow = workflowsByCallId.get(callId);
    if (!workflow) return;
    const completed = notification.status === "completed";
    workflow.status = notification.status;
    ctx.emit({
      type: "tool",
      callId,
      status: completed ? "done" : "error",
      output: notification.summary,
    });
    if (latestWorkflowCallId === callId && completed) {
      ctx.emit({ type: "plan", steps: workflowSteps(workflow, "completed") });
    }
    if (!completed) {
      ctx.emit({
        type: "notice",
        tone: "error",
        text:
          notification.summary ||
          `${workflow.name} ${notification.status}.`,
      });
    }
  }

  function handleNotificationFrame(
    frame: Record<string, unknown>,
    message: Record<string, unknown> | null,
    ctx: AdapterContext,
  ): void {
    const candidates = [
      asString(frame.content),
      asString(frame.prompt),
      asString(asRecord(frame.attachment)?.prompt),
      asString(message?.content),
      ...asArray(message?.content).map((raw) => {
        if (typeof raw === "string") return raw;
        const block = asRecord(raw);
        return asString(block?.text) ?? asString(block?.content);
      }),
    ];
    for (const candidate of candidates) {
      if (candidate) handleTaskNotification(candidate, ctx);
    }
  }

  /** Claude asking whether a tool may run. */
  function handleControlRequest(frame: Record<string, unknown>, ctx: AdapterContext) {
    const requestId = asString(frame.request_id);
    const request = asRecord(frame.request);
    const subtype = asString(request?.subtype);
    if (!requestId || !request) return;

    if (subtype !== "can_use_tool") {
      // Anything else is Claude asking for a capability we do not implement.
      // Answering "unsupported" is better than leaving it waiting forever.
      ctx.send({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: requestId,
          error: `Duckweed does not support ${subtype ?? "this request"}`,
        },
      });
      return;
    }

    const name = asString(request.tool_name) ?? "tool";
    const input = asRecord(request.input) ?? {};
    const permissionId = `perm-${requestId}`;

    const questions = name.toLowerCase() === QUESTION_TOOL ? questionsFrom(input) : [];
    if (questions.length > 0) {
      pendingPermissions.set(permissionId, { requestId, input, questions });
      ctx.emit({
        type: "permission",
        permission: {
          id: permissionId,
          kind: "question",
          title:
            questions.length === 1
              ? questions[0].question
              : `${questions.length} questions for you`,
          detail: null,
          command: null,
          changes: [],
          // The card draws its own answer controls; the only fixed action is
          // walking away from the question without answering it.
          options: [{ id: "deny", label: "Skip", kind: "reject" }],
          questions,
        },
      });
      return;
    }

    pendingPermissions.set(permissionId, { requestId, input, questions: null });
    ctx.emit({
      type: "permission",
      permission: {
        id: permissionId,
        kind: "approval",
        title: `${name} wants to run`,
        detail: describeTool(name, input),
        command: asString(input.command),
        changes: changesFor(name, input),
        options: [
          { id: "allow", label: "Allow", kind: "allow" },
          { id: "deny", label: "Deny", kind: "reject" },
        ],
      },
    });
  }

  function handleResult(frame: Record<string, unknown>, ctx: AdapterContext) {
    const usage = asRecord(frame.usage);
    if (usage) emitUsage(usage, ctx);
    const cost = frame.total_cost_usd;
    if (typeof cost === "number") ctx.emit({ type: "usage", usage: { costUsd: cost } });
    if (frame.is_error === true) {
      if (goalResponsePending) {
        currentGoal = goalBeforeCommand;
        ctx.emit({ type: "goal", goal: currentGoal });
      }
      emitTurnError(asString(frame.result) ?? "The turn failed.", ctx);
    }
    goalResponsePending = false;
    ctx.emit({ type: "turn-end" });
  }

  /** The CLI answering one of our control requests. */
  function handleControlResponse(frame: Record<string, unknown>, ctx: AdapterContext) {
    const response = asRecord(frame.response);
    const requestId = asString(response?.request_id);
    if (!requestId) return;
    const model = pendingModelChanges.get(requestId);
    if (model !== undefined) {
      pendingModelChanges.delete(requestId);
      if (asString(response?.subtype) === "success") {
        ctx.emit({ type: "session", model });
        ctx.emit({ type: "notice", tone: "info", text: `Model set to ${model}.` });
      } else {
        ctx.emit({
          type: "notice",
          tone: "error",
          text: asString(response?.error) ?? `Claude refused model "${model}".`,
        });
      }
      return;
    }

    const accessChange = pendingAccessChanges.get(requestId);
    if (accessChange === undefined) return;
    pendingAccessChanges.delete(requestId);
    if (asString(response?.subtype) === "success") {
      ctx.emit({ type: "session", accessMode: accessChange.mode });
      const label =
        accessChange.mode === "default"
          ? "Agent default"
          : accessChange.mode === "read-only"
            ? "Read only"
            : accessChange.mode === "workspace"
              ? "Workspace"
              : "Full access";
      if (accessChange.announce) {
        ctx.emit({ type: "notice", tone: "info", text: `Access set to ${label}.` });
      }
      return;
    }
    ctx.emit({
      type: "notice",
      tone: "error",
      text: asString(response?.error) ?? "Claude refused the requested access level.",
    });
  }

  /**
   * Effort levels `/effort` accepts. The CLI usage line lists
   * low|medium|high|xhigh|max|auto; `ultracode` is plan/workflow-gated and
   * returns a clear refusal when unavailable (verified against claude 2.1.220).
   */
  const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max", "auto", "ultracode"]);

  function setAccessMode(
    mode: AgentAccessMode,
    ctx: AdapterContext,
    announce: boolean,
  ): void {
    const nativeMode =
      mode === "read-only"
        ? "plan"
        : mode === "workspace"
          ? "acceptEdits"
          : mode === "full-access"
            ? "bypassPermissions"
            : "default";
    controlSeq += 1;
    const requestId = `dw-access-${controlSeq}`;
    pendingAccessChanges.set(requestId, { mode, announce });
    ctx.send({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "set_permission_mode", mode: nativeMode },
    });
  }

  function handleCommand(text: string, ctx: AdapterContext): "handled" | "prompt" {
    const space = text.search(/\s/);
    const name = (space < 0 ? text : text.slice(0, space)).toLowerCase();
    const arg = space < 0 ? "" : text.slice(space + 1).trim();

    if (name === "/goal") {
      goalBeforeCommand = currentGoal;
      goalResponsePending = true;
      const goal = goalAfterCommand(currentGoal, text);
      if (goal !== undefined) {
        currentGoal = goal;
        ctx.emit({ type: "goal", goal });
      }
      return "prompt";
    }

    if (name === "/workflows" && workflowsByCallId.size > 0) {
      const running = [...workflowsByCallId.values()].filter(
        (workflow) =>
          workflow.status === "launching" || workflow.status === "running",
      ).length;
      ctx.emit({
        type: "notice",
        tone: "info",
        text:
          running > 0
            ? `Workflow progress is shown above the composer. ${running} ${
                running === 1 ? "workflow is" : "workflows are"
              } still running.`
            : "Workflow progress is shown above the composer.",
      });
      return "handled";
    }

    if (name === "/model" && arg) {
      // A structured switch, so the header can trust what it shows. The CLI
      // would also accept this as plain slash text, but its confirmation
      // sentence names a display label, not the id we were given.
      controlSeq += 1;
      const requestId = `dw-model-${controlSeq}`;
      pendingModelChanges.set(requestId, arg);
      ctx.emit({ type: "user", text });
      ctx.send({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "set_model", model: arg },
      });
      return "handled";
    }

    if (name === "/effort" && arg) {
      const level = arg.toLowerCase();
      if (!EFFORT_LEVELS.has(level)) {
        ctx.emit({ type: "user", text });
        ctx.emit({
          type: "notice",
          tone: "error",
          text: `Unknown effort "${arg}". Pick low, medium, high, xhigh, max, auto, or ultracode.`,
        });
        return "handled";
      }
      // Validated against the same set the CLI enforces, so the header can
      // move now; the CLI's own confirmation lands right behind it.
      ctx.emit({ type: "session", effort: level });
      return "prompt";
    }

    // Everything else — /compact, /clear, bare /model or /effort, and any
    // skill — the CLI interprets slash text itself, including answering
    // unknown commands with a synthetic "Unknown command" message.
    return "prompt";
  }

  function sendUserMessage(prompt: AgentPrompt, ctx: AdapterContext): void {
    ctx.send({
      type: "user",
      message: {
        role: "user",
        content: [
          ...prompt.images.map((image) => ({
            type: "image",
            source: {
              type: "base64",
              media_type: image.mimeType,
              data: imagePayloadBase64(image),
            },
          })),
          ...(prompt.text ? [{ type: "text", text: prompt.text }] : []),
        ],
      },
    });
  }

  return {
    endsOnStdinClose: true,

    // No `resume` here on purpose: `stream-json` has no method for swapping
    // conversations, so the session store relaunches the CLI with the flags
    // below. That is also what `claude --resume <id>` does interactively.
    args: (launch: AgentLaunch) => {
      const extra: string[] = [];
      if (launch.model) extra.push("--model", launch.model);
      if (launch.effort) extra.push("--effort", launch.effort);
      if (launch.resumeId) extra.push("--resume", launch.resumeId);
      else if (launch.resume) extra.push("--continue");
      return extra;
    },

    start: (ctx) => {
      // Nothing to hand shake: the CLI is ready as soon as it is up, and the
      // `system/init` frame that names the model only arrives with the first
      // turn. Opening prompts are sent by the session, not here. The session
      // already seeded Claude's model aliases so the picker works immediately.
      const accessMode = ctx.launch.accessMode ?? "default";
      if (accessMode !== "default") setAccessMode(accessMode, ctx, false);
      ctx.emit({ type: "status", status: "idle" });
    },

    receive: (line, ctx) => {
      const frame = parseJson(line);
      if (!frame) return;
      const type = asString(frame.type);

      switch (type) {
        case "system": {
          if (asString(frame.subtype) !== "init") {
            handleNotificationFrame(frame, null, ctx);
            return;
          }
          const commands = asArray(frame.slash_commands)
            .map((name) => asString(name))
            .filter((name): name is string => name !== null)
            .map((name) => ({ name: `/${name}`, description: "" }));
          // Prefer the raw model id from init (`claude-opus-5[1m]`); the
          // session already seeded the alias list for the picker.
          ctx.emit({
            type: "session",
            sessionId: asString(frame.session_id) ?? undefined,
            model: asString(frame.model) ?? undefined,
            cwd: asString(frame.cwd) ?? undefined,
            commands,
          });
          return;
        }
        case "stream_event": {
          const event = asRecord(frame.event);
          if (event) handleStreamEvent(event, ctx);
          return;
        }
        case "assistant": {
          const message = asRecord(frame.message);
          if (!message) return;
          const parentCallId =
            asString(frame.parent_tool_use_id) ??
            asString(message.parent_tool_use_id);
          if (parentCallId) {
            handleSubagentAssistant(message, parentCallId, ctx);
          } else {
            handleAssistant(message, frame, ctx);
          }
          return;
        }
        case "user": {
          const message = asRecord(frame.message);
          if (!message) return;
          handleNotificationFrame(frame, message, ctx);
          const parentCallId =
            asString(frame.parent_tool_use_id) ??
            asString(message.parent_tool_use_id);
          if (parentCallId) {
            handleSubagentToolResults(message, parentCallId, ctx);
          } else {
            handleToolResults(message, frame, ctx);
          }
          return;
        }
        case "queue-operation":
        case "attachment":
          handleNotificationFrame(frame, null, ctx);
          return;
        case "control_request":
          handleControlRequest(frame, ctx);
          return;
        case "control_response":
          handleControlResponse(frame, ctx);
          return;
        case "result":
          handleResult(frame, ctx);
          return;
        default:
          return;
      }
    },

    prompt: (prompt, ctx) => {
      seenTurnErrors.clear();
      ctx.emit({ type: "user", text: prompt.text, images: prompt.images });
      ctx.emit({ type: "status", status: "working" });
      sendUserMessage(prompt, ctx);
    },

    // Stream-json keeps stdin open while Claude is working. A user message
    // written during that time is applied to the active conversation at the
    // next safe processing boundary, which is Claude Code's steering path.
    steer: (prompt, ctx) => {
      ctx.emit({ type: "user", text: prompt.text, images: prompt.images });
      sendUserMessage(prompt, ctx);
      return true;
    },

    command: handleCommand,

    configureAccess: (mode, ctx) => {
      setAccessMode(mode, ctx, true);
      return true;
    },

    interrupt: (ctx) => {
      controlSeq += 1;
      ctx.send({
        type: "control_request",
        request_id: `dw-int-${controlSeq}`,
        request: { subtype: "interrupt" },
      });
    },

    respond: (permissionId, optionId, ctx) => {
      const pending = pendingPermissions.get(permissionId);
      if (!pending) return;
      pendingPermissions.delete(permissionId);
      const allowed = optionId === "allow";
      ctx.send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: pending.requestId,
          response: allowed
            ? { behavior: "allow", updatedInput: pending.input }
            : {
                behavior: "deny",
                // A skipped question is not a refused tool. Saying which one
                // happened is the difference between Claude asking again in a
                // better way and Claude assuming it is not allowed to ask.
                message: pending.questions
                  ? "The user skipped the question without answering. Continue with your own best judgement, or ask again if you truly cannot proceed."
                  : "Denied in Duckweed",
              },
        },
      });
      ctx.emit({ type: "permission", permission: null });
      ctx.emit({ type: "status", status: "working" });
    },

    /**
     * Hand the user's choices back as the tool's own input.
     *
     * Claude Code's `AskUserQuestion` takes its result from an `answers` map
     * the client fills in: question text to answer text, several choices
     * comma-separated, with anything the user typed alongside a choice carried
     * as an annotation note. Allowing the call with those filled in is what
     * actually answers the question. Verified against claude 2.1.220, which
     * replies "The user answered: …" and reads it back correctly.
     */
    answer: (permissionId, answers, ctx) => {
      const pending = pendingPermissions.get(permissionId);
      if (!pending?.questions) return;
      pendingPermissions.delete(permissionId);

      const asked = new Map(pending.questions.map((question) => [question.id, question]));
      const collected: Record<string, string> = {};
      const annotations: Record<string, { notes: string }> = {};
      for (const reply of answers) {
        const question = asked.get(reply.questionId);
        if (!question) continue;
        const custom = reply.custom?.trim() ?? "";
        // Text on its own is the answer; text beside a choice is a note about
        // that choice, which is exactly the distinction the tool draws.
        const text = reply.labels.length ? reply.labels.join(", ") : custom;
        if (!text) continue;
        collected[question.question] = text;
        if (custom && reply.labels.length) annotations[question.question] = { notes: custom };
      }

      ctx.send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: pending.requestId,
          response: {
            behavior: "allow",
            updatedInput: {
              ...pending.input,
              answers: collected,
              ...(Object.keys(annotations).length ? { annotations } : {}),
            },
          },
        },
      });
      ctx.emit({ type: "permission", permission: null });
      ctx.emit({ type: "status", status: "working" });
    },
  };
}
