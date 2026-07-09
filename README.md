# Claude Usage Dashboard

A [Claude Code](https://claude.com/claude-code) plugin that tracks your **token usage and cost** across all your projects and publishes a **live hosted dashboard** — with optional **prompt-efficiency analysis** that tells you how to prompt better and cheaper.

Everything runs locally from your own Claude Code transcripts (`~/.claude/projects`). No server to host, no account to create, no data uploaded to any third party — the dashboard is published as a private-by-default Claude Artifact at a stable URL you can share with your team.

## Install

```
/plugin marketplace add vimmiso/claude-usage-plugin
/plugin install usage@claude-usage
```

## Use

```
/usage:dash                     refresh the dashboard (fast)
/usage:dash --deep              + analyze your costliest sessions' prompts and
                                embed concrete improvement suggestions
/usage:dash --projects myrepo   scope to project folders matching a regex
/usage:dash --days 60           change the daily-chart window (default 30)
```

On every run the dashboard redeploys to the **same URL** (stored in `~/.claude/claude-usage-state.json`), so a bookmarked link always shows current data. For automatic refresh, run `/loop 30m /usage:dash` or set up a `/schedule` routine.

## What the dashboard shows

- **Headline tiles** — estimated total cost (USD), total tokens, prompts, cache hit rate, cache savings
- **Daily cost chart** — spend per day over the selected window
- **Cost by model and by project** — where the money goes
- **Token composition** — cache reads vs cache writes vs fresh input vs output (cache reads are ~10× cheaper)
- **Most expensive sessions** — the top candidates for prompt improvement
- **Prompt insights** (deep mode) — anti-patterns found in your costliest sessions, each with severity, a real (anonymized) example, a suggested rewrite, and estimated cost impact

## How it works

1. A dependency-free Node script (Node 18+, built-ins only) scans `~/.claude/projects/**/*.jsonl`, dedupes streamed usage records, and aggregates tokens/cost per session, project, model, and day. Costs are estimated from published per-token API pricing including cache economics (writes 1.25×/2× input, reads 0.1×) — the pricing table lives at the top of `skills/usage/scripts/analyze-usage.mjs`.
2. It emits a self-contained `dashboard.html` (no external assets, light/dark theme aware).
3. Claude publishes it via the Artifact tool to a stable URL. If Artifacts aren't available in your session, the HTML file opens locally in a browser instead.
4. In `--deep` mode, Claude reviews the user prompts of your top-12 costliest sessions against an anti-pattern checklist (vague first prompts, repeated corrections, re-explained context, monolithic asks, …) and bakes the findings into the dashboard.

## Requirements

- Claude Code with plugin support
- Node.js 18+
- Artifact tool available for hosted publishing (optional — falls back to a local HTML file)

## Privacy

All parsing happens on your machine. Nothing is sent anywhere except the rendered dashboard HTML, which is published as a **private-by-default** Claude Artifact only when you run the command. Deep-mode findings quote short anonymized prompt excerpts — review the dashboard before sharing the link.

## License

MIT
