let meta = #{
    name: "suggest-improvements",
    description: "Analyze the Duckweed repo and propose five high-leverage product or engineering improvements (read-only, no code changes)",
    when_to_use: "When you want creative, grounded feature/architecture ideas without implementing anything yet",
    phases: [
        #{ title: "Map", detail: "orient on product, stack, and current branch work" },
        #{ title: "Explore", detail: "parallel deep dives across product surfaces" },
        #{ title: "Synthesize", detail: "pick and shape the five best suggestions" },
    ],
};

let ideas_schema = #{
    "type": "object",
    "required": ["ideas"],
    "properties": #{
        "ideas": #{
            "type": "array",
            "minItems": 2,
            "maxItems": 4,
            "items": #{
                "type": "object",
                "required": ["title", "why", "how", "effort", "impact", "evidence"],
                "properties": #{
                    "title": #{ "type": "string" },
                    "why": #{ "type": "string" },
                    "how": #{ "type": "string" },
                    "effort": #{ "type": "string", "enum": ["S", "M", "L"] },
                    "impact": #{ "type": "string", "enum": ["low", "medium", "high"] },
                    "evidence": #{ "type": "string" },
                },
            },
        },
    },
};

let final_schema = #{
    "type": "object",
    "required": ["summary", "suggestions"],
    "properties": #{
        "summary": #{ "type": "string" },
        "suggestions": #{
            "type": "array",
            "minItems": 5,
            "maxItems": 5,
            "items": #{
                "type": "object",
                "required": ["rank", "title", "pitch", "why_now", "approach", "effort", "impact", "risks", "evidence"],
                "properties": #{
                    "rank": #{ "type": "integer" },
                    "title": #{ "type": "string" },
                    "pitch": #{ "type": "string" },
                    "why_now": #{ "type": "string" },
                    "approach": #{ "type": "string" },
                    "effort": #{ "type": "string", "enum": ["S", "M", "L"] },
                    "impact": #{ "type": "string", "enum": ["low", "medium", "high"] },
                    "risks": #{ "type": "string" },
                    "evidence": #{ "type": "string" },
                },
            },
        },
    },
};

// --- Phase 1: orient ---
phase("Map");
log("Mapping product intent, stack, and in-flight work (read-only)");

let map_prompt = "";
map_prompt += "You are exploring the Duckweed repository (a local Tauri + React terminal workspace for vibe coding with multi-agent panes). ";
map_prompt += "READ-ONLY: do not edit, create, or delete any files. Do not run builds or installers. ";
map_prompt += "Use list_dir, read_file, and grep only.\n\n";
map_prompt += "Tasks:\n";
map_prompt += "1. Read README.md, AGENTS.md, package.json, and docs/releases.md (if present).\n";
map_prompt += "2. Skim src/App.tsx, src/components structure, src/lib/agents, and src-tauri/src entry points.\n";
map_prompt += "3. Note any plan docs (e.g. SUBAGENT_WORKFLOW_UI_PLAN.md) and what the current feature branch seems to be about from filenames under src/.\n";
map_prompt += "4. Return a concise product map: what Duckweed is, core surfaces (terminal, agents, git, layout), tech stack, and 5-8 interesting seams or unfinished edges you noticed.\n";
map_prompt += "Be concrete and cite file paths. No implementation suggestions yet beyond naming the seams.";

let map_result = agent(map_prompt, #{
    label: "map:product",
    capability_mode: "read-only",
});

let product_map = "Map agent failed or returned empty.";
if map_result != () && map_result.success && map_result.output != () {
    product_map = map_result.output;
}
log("Product map ready; starting parallel exploration");

// --- Phase 2: parallel domain exploration ---
phase("Explore");

let domains = [
    #{
        id: "agent-orchestration",
        focus: "multi-agent UX, subagent fleet, adapters (Claude/Codex/ACP), session events, goals, permissions, parallel agent panes",
        paths: "src/lib/agents/, src/components/agent/, SUBAGENT_WORKFLOW_UI_PLAN.md",
    },
    #{
        id: "terminal-workspace",
        focus: "tiling panes, tabs, xterm, shell integration, layout persistence, keyboard shortcuts, multi-pane workflows",
        paths: "src/components/ (terminal/pane related), src/hooks/, src/App.tsx, README shortcuts section",
    },
    #{
        id: "git-and-context",
        focus: "git diffs, changes UI, project context, workspace open/folder, local session state, no-cloud philosophy",
        paths: "src/hooks/useGitChanges.ts, git-related components/lib, README product principles",
    },
    #{
        id: "desktop-polish",
        focus: "Tauri desktop app, updater, installers, windows hooks, tray/window UX, performance of local app",
        paths: "src-tauri/, src/hooks/useUpdater.ts, package.json scripts, docs/releases.md",
    },
    #{
        id: "dx-and-quality",
        focus: "testing, type safety, release scripts, architecture clarity, developer experience for contributors",
        paths: "scripts/, *.test.ts(x), vite.config.ts, tsconfig.json, CLAUDE.md/AGENTS.md",
    },
];

let explore_jobs = [];
for d in domains {
    let p = "";
    p += "You are a product+engineering scout for Duckweed (local Tauri terminal workspace for multi-agent vibe coding).\n";
    p += "STRICTLY READ-ONLY: never edit files, never run write/build commands. Use list_dir, read_file, grep only.\n\n";
    p += "Domain: " + d.id + "\n";
    p += "Focus: " + d.focus + "\n";
    p += "Start from these paths: " + d.paths + "\n\n";
    p += "Product context from the map agent (may be partial):\n";
    p += json_encode(product_map) + "\n\n";
    p += "Your job:\n";
    p += "1. Inspect real code under your domain (not just README). Open 6+ files.\n";
    p += "2. Propose 2-4 COOL, high-leverage improvements that fit Duckweed's identity ";
    p += "(local-first, real shells, multi-agent panes, no cloud account, English UI, no glow unless requested).\n";
    p += "3. Prefer ideas that are delightful for vibe-coders OR clean architectural wins visible to users.\n";
    p += "4. Avoid generic advice (\"add more tests\") unless uniquely valuable and specific.\n";
    p += "5. For each idea fill: title, why (user value), how (concrete approach with file/module hooks), ";
    p += "effort S/M/L, impact low/medium/high, evidence (paths/behaviors you actually saw).\n";
    p += "Do not implement anything. Ideas only.";

    explore_jobs.push(#{
        prompt: p,
        label: "explore:" + d.id,
        capability_mode: "read-only",
        output_schema: ideas_schema,
    });
}

let explore_results = parallel(explore_jobs);

let all_ideas = [];
let i = 0;
for r in explore_results {
    let domain_id = domains[i].id;
    if r != () && r.success && r.output != () && r.output.ideas != () {
        for idea in r.output.ideas {
            all_ideas.push(#{
                domain: domain_id,
                title: idea.title,
                why: idea.why,
                how: idea.how,
                effort: idea.effort,
                impact: idea.impact,
                evidence: idea.evidence,
            });
        }
        log("explore:" + domain_id + " returned ideas");
    } else {
        log("explore:" + domain_id + " failed or empty — skipping");
    }
    i += 1;
}

if all_ideas.len() == 0 {
    complete(#{
        summary: "Exploration produced no ideas; check agent failures.",
        suggestions: [],
    });
}

log(all_ideas.len().to_string() + " candidate ideas collected; synthesizing top 5");

// --- Phase 3: synthesize top 5 ---
phase("Synthesize");

let synth_prompt = "";
synth_prompt += "You are the product lead for Duckweed. READ-ONLY: do not change any code.\n";
synth_prompt += "You may re-read a few key files with read_file/grep if needed to sharpen a suggestion, but do not implement.\n\n";
synth_prompt += "Product map:\n";
synth_prompt += json_encode(product_map) + "\n\n";
synth_prompt += "Candidate ideas from domain scouts (JSON):\n";
synth_prompt += json_encode(all_ideas) + "\n\n";
synth_prompt += "Select and refine EXACTLY 5 suggestions. Rules:\n";
synth_prompt += "- Diversity: cover different user-visible wins; do not pick five variations of the same theme.\n";
synth_prompt += "- Cool factor: prefer distinctive Duckweed-native ideas over generic SaaS backlog filler.\n";
synth_prompt += "- Grounded: every suggestion must cite real evidence (paths, modules, existing behaviors).\n";
synth_prompt += "- Actionable: approach should be concrete enough that an engineer could start tomorrow.\n";
synth_prompt += "- Respect product constraints: local-first, no required cloud account, English UI, no glow effects, multi-agent + real terminals.\n";
synth_prompt += "- Rank 1 = best overall (impact × cool × fit / effort). ranks 1..5.\n";
synth_prompt += "- Write pitches and approaches in clear English (complete sentences).\n";
synth_prompt += "- summary: 2-4 sentences on the theme of the set.\n";
synth_prompt += "Return only the structured schema.";

let synth = agent(synth_prompt, #{
    label: "synthesize:top-5",
    capability_mode: "read-only",
    output_schema: final_schema,
});

if synth == () || !synth.success || synth.output == () {
    // Fail open with raw candidates so the run still yields value
    let fallback_path = write_scratch_file("suggestions-fallback.md", json_encode(all_ideas));
    complete(#{
        summary: "Synthesis agent failed; returning raw candidate pool only.",
        path: fallback_path,
        candidates: all_ideas,
        suggestions: [],
    });
}

// Human-readable report artifact
let report = "# Duckweed: five suggested improvements\n\n";
report += synth.output.summary + "\n\n";
for s in synth.output.suggestions {
    report += "## " + s.rank.to_string() + ". " + s.title + "\n\n";
    report += "**Pitch:** " + s.pitch + "\n\n";
    report += "**Why now:** " + s.why_now + "\n\n";
    report += "**Approach:** " + s.approach + "\n\n";
    report += "**Effort:** " + s.effort + " · **Impact:** " + s.impact + "\n\n";
    report += "**Risks:** " + s.risks + "\n\n";
    report += "**Evidence:** " + s.evidence + "\n\n";
    report += "---\n\n";
}
report += "_Generated by suggest-improvements workflow. No code was modified._\n";

let report_path = write_scratch_file("five-suggestions.md", report);
log("Wrote report to " + report_path);

complete(#{
    summary: synth.output.summary,
    path: report_path,
    suggestions: synth.output.suggestions,
});
