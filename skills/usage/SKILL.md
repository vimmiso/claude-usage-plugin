---
name: usage
description: "Claude Code usage & prompt-efficiency tracker. Parses your Claude Code session transcripts (~/.claude/projects), aggregates token usage and estimated cost (tokens + USD, incl. cache economics), publishes a live dashboard Artifact at a stable URL, and — in --deep mode — analyzes the costliest sessions' prompts and embeds concrete improvement suggestions in the dashboard. Trigger on 'token usage', 'usage dashboard', 'how much did Claude cost', 'prompt efficiency', 'improve my prompts', '/usage:dash'."
---

# usage — Claude Usage & Prompt Efficiency Dashboard

## Purpose

Track how much Claude Code usage costs across your projects, and improve the prompts you write based on what the data shows. Output is a hosted dashboard Artifact that redeploys to the **same URL** on every run.

**Two modes:**

| Mode | Command | What it does |
|------|---------|--------------|
| **Standard** | `/usage:dash` | Aggregate usage → refresh dashboard (fast, no LLM analysis) |
| **Deep** | `/usage:dash --deep` | Standard + analyze the costliest sessions' prompts → embed findings + rewrites in the dashboard |

## State file (stable Artifact URL)

`~/.claude/claude-usage-state.json` — `{ "artifactUrl": "https://claude.ai/…" }`

- If it exists, pass its `artifactUrl` as the `url` parameter to the Artifact tool so the dashboard redeploys to the same address.
- If missing (first run on this machine), publish without `url`, then write the returned URL into the state file.

## Step 1 — Run the analyzer

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/usage/scripts/analyze-usage.mjs" \
  --out <scratchpad>/claude-usage [--deep] [--findings <path>]
```

Options:
- `--out <dir>` — output directory (use the session scratchpad)
- `--projects <regex>` — project-folder filter (default `.` = all projects, case-insensitive; e.g. `--projects myrepo` to scope down)
- `--days <n>` — daily-chart window (default 30)
- `--deep` — also emit `deep-manifest.json` (top-12 costliest sessions with their user prompts)
- `--findings <file>` — embed a prompt-analysis findings JSON into the dashboard

Outputs: `usage-data.json`, `dashboard.html`, and (deep) `deep-manifest.json`. The script prints a JSON summary to stdout — read it instead of re-parsing the files.

Requires Node 18+. Costs are estimates from published API per-token pricing (cache writes 1.25×/2× input, cache reads 0.1×); the pricing table lives at the top of the script — update it there when models/prices change.

## Step 2 (deep mode only) — Analyze prompts, write findings

1. Read `deep-manifest.json`. For each expensive session, review `promptTexts` looking for these anti-patterns:
   - **Vague first prompt** → long exploration loops (many tool calls, high tokens, few prompts)
   - **Repeated corrections** ("no, I meant…", "actually…") → unclear initial ask
   - **Re-explaining context** a skill or CLAUDE.md already covers → suggest referencing the skill instead
   - **Missing skill invocation** — work that matches an available skill done via raw prompting
   - **Monolithic asks** — one prompt bundling many unrelated tasks (kills cache, balloons context)
   - **Recurring context** pasted across sessions → candidate to fold into a skill/CLAUDE.md
2. Write `findings.json` in the same output dir:

```json
{
  "generatedAt": "<ISO>",
  "summary": "1–2 sentence overall read of the prompting patterns.",
  "items": [
    {
      "severity": "high | medium | low",
      "title": "Short pattern name",
      "detail": "What happens and why it costs tokens.",
      "example": "Anonymized quote from a real prompt (trim to ~120 chars)",
      "rewrite": "A concrete better version of the prompt, or the skill to invoke instead",
      "estImpact": "e.g. ~$12 across 3 sessions"
    }
  ]
}
```

Keep it to the 3–6 highest-impact findings. Quote real prompts but strip anything sensitive (tokens, URLs with secrets, names).

3. Re-run Step 1 with `--findings <path-to-findings.json>` to bake them into the dashboard.

## Step 3 — Publish the dashboard

1. Read the state file. Publish `<out>/dashboard.html` with the Artifact tool:
   - `favicon`: `📊` (keep stable)
   - `description`: "Claude Code token usage, cost, and prompt-efficiency dashboard"
   - `url`: the stored `artifactUrl` (omit on first run)
2. Save/refresh the returned URL into `~/.claude/claude-usage-state.json`.
3. If the Artifact tool is unavailable in the current session, tell the user to open `<out>/dashboard.html` directly in a browser instead.

## Step 4 — Report

Give the user: the dashboard URL, headline numbers (total est. cost, tokens, sessions, cache hit rate, cache savings), the top 1–2 cost drivers, and — in deep mode — the top findings in one line each.

## Keeping it "real-time"

The dashboard refreshes whenever the command runs. For automatic refresh suggest:
- `/loop 30m /usage:dash` — refresh every 30 min during a work session
- a scheduled routine (`/schedule`) for a daily refresh
