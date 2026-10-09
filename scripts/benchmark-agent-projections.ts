/**
 * Reproduce projection cost during a parent response stream.
 *
 * bun scripts/benchmark-agent-projections.ts
 * bun scripts/benchmark-agent-projections.ts --baseline HEAD
 *
 * Measures these pure projections, not whole-app CPU, RAM, or frame rate.
 * Baseline modules come from Git and use current unchanged dependencies.
 */
import { deepStrictEqual } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AgentItem } from "../src/lib/agents/types";
import { subagentRosters, subagentsForTurn } from "../src/lib/agents/subagents";
import { activityGroups } from "../src/components/agent/official/OfficialShared";

type Projections = {
  subagentRosters: typeof subagentRosters;
  subagentsForTurn: typeof subagentsForTurn;
  activityGroups: typeof activityGroups;
};

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORICAL_TURNS = 250;
const STREAM_UPDATES = 200;
const SAMPLES = 3;

function workload(): AgentItem[] {
  const items: AgentItem[] = [];
  for (let index = 0; index < HISTORICAL_TURNS; index += 1) {
    items.push({ kind: "user", id: `u-${index}`, at: index, text: "Inspect the code" });
    items.push({
      kind: "tool", tool: "task", name: "Agent", id: `t-${index}`,
      callId: `c-${index}`, at: index, title: "Inspect", status: "done",
      command: null, output: "Completed inspection with details\n".repeat(300), changes: [],
    });
    items.push({
      kind: "assistant", id: `a-${index}`, at: index,
      text: "Inspection complete", streaming: false,
    });
  }
  items.push({ kind: "user", id: "u-live", at: 1_000, text: "Continue" });
  items.push({
    kind: "tool", tool: "read", name: "Read", id: "t-live", callId: "c-live",
    at: 1_000, title: "Read", status: "done", command: null, output: "", changes: [],
  });
  items.push({
    kind: "assistant", id: "a-live", at: 1_000, text: "Streaming response", streaming: true,
  });
  return items;
}

function sample(projections: Projections) {
  const history = workload();
  let previousGroups: ReturnType<typeof activityGroups> | undefined;
  let previousRosters: ReturnType<typeof subagentRosters> | undefined;
  let previousFleet: ReturnType<typeof subagentsForTurn> | undefined;
  let stableHistoricalGroups = 0;
  let stableRosters = 0;
  let stableFleet = 0;
  const started = performance.now();
  for (let index = 0; index < STREAM_UPDATES; index += 1) {
    const items = history.slice();
    const live = items[items.length - 1];
    if (live.kind !== "assistant") throw new Error("Expected live assistant workload");
    items[items.length - 1] = { ...live, text: `Streaming response ${index}` };
    const groups = projections.activityGroups(items);
    const rosters = projections.subagentRosters(items);
    const fleet = projections.subagentsForTurn(items);
    if (previousGroups) {
      for (let turn = 0; turn < HISTORICAL_TURNS; turn += 1) {
        stableHistoricalGroups += Number(groups[turn] === previousGroups[turn]);
      }
    }
    if (previousRosters) stableRosters += Number(rosters === previousRosters);
    if (previousFleet) stableFleet += Number(fleet === previousFleet);
    previousGroups = groups;
    previousRosters = rosters;
    previousFleet = fleet;
  }
  return { elapsedMs: performance.now() - started, stableHistoricalGroups, stableRosters, stableFleet };
}

function measure(projections: Projections) {
  const samples = Array.from({ length: SAMPLES }, () => sample(projections));
  const times = samples.map((result) => result.elapsedMs).sort((a, b) => a - b);
  return {
    medianMs: times[Math.floor(times.length / 2)],
    sampleTimesMs: samples.map((result) => result.elapsedMs),
    reuse: {
      historicalGroups: samples[0].stableHistoricalGroups,
      possibleHistoricalGroups: HISTORICAL_TURNS * (STREAM_UPDATES - 1),
      rosterArrays: samples[0].stableRosters,
      fleetArrays: samples[0].stableFleet,
      possibleArrayReuses: STREAM_UPDATES - 1,
    },
  };
}

async function baselineModule(relativePath: string, reference: string, directory: string) {
  const result = Bun.spawnSync(["git", "show", `${reference}:${relativePath}`], {
    cwd: workspace, stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  const originalDirectory = dirname(resolve(workspace, relativePath));
  const transpiler = new Bun.Transpiler({ loader: relativePath.endsWith(".tsx") ? "tsx" : "ts" });
  const source = transpiler.transformSync(result.stdout.toString()).replace(
    /(\bfrom\s+|\bimport\s*)(["'])([^"']+)\2/g,
    (_match, prefix: string, _quote: string, specifier: string) => {
      const target = specifier.startsWith(".")
        ? pathToFileURL(resolve(originalDirectory, specifier)).href
        : import.meta.resolve(specifier);
      return `${prefix}${JSON.stringify(target)}`;
    },
  );
  const path = join(directory, basename(relativePath).replace(/\.tsx?$/, ".mjs"));
  await writeFile(path, source, "utf8");
  return import(pathToFileURL(path).href);
}

const baselineIndex = Bun.argv.indexOf("--baseline");
const reference = baselineIndex >= 0 ? Bun.argv[baselineIndex + 1] : undefined;
if (baselineIndex >= 0 && !reference) throw new Error("--baseline requires a Git reference");
let baseline: ReturnType<typeof measure> | undefined;
if (reference) {
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, "duckweed-agent-benchmark-"));
  try {
    const [workers, timeline] = await Promise.all([
      baselineModule("src/lib/agents/subagents.ts", reference, directory),
      baselineModule("src/components/agent/official/OfficialShared.tsx", reference, directory),
    ]);
    const comparisonItems = workload();
    deepStrictEqual(workers.subagentRosters(comparisonItems), subagentRosters(comparisonItems));
    deepStrictEqual(workers.subagentsForTurn(comparisonItems), subagentsForTurn(comparisonItems));
    deepStrictEqual(timeline.activityGroups(comparisonItems), activityGroups(comparisonItems));
    baseline = measure({ ...workers, activityGroups: timeline.activityGroups });
  } finally {
    if (dirname(directory) !== temporaryRoot || !basename(directory).startsWith("duckweed-agent-benchmark-")) {
      throw new Error("Unexpected benchmark temporary directory");
    }
    await rm(directory, { recursive: true, force: true });
  }
}
const current = measure({ subagentRosters, subagentsForTurn, activityGroups });
console.log(JSON.stringify({
  scope: "Pure agent transcript/subagent projections during parent-only streaming",
  workload: { historicalDelegatedTurns: HISTORICAL_TURNS, streamUpdates: STREAM_UPDATES, outputLinesPerTask: 300, samples: SAMPLES },
  baselineReference: reference ?? null,
  baselineOutputParity: reference ? "passed" : "not requested",
  baseline,
  current,
  timeReductionPercent: baseline ? (1 - current.medianMs / baseline.medianMs) * 100 : undefined,
}, null, 2));
