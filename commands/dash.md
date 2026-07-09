Track Claude Code token usage & cost across your projects and publish/refresh the live usage dashboard. Arguments: $ARGUMENTS (optional: --deep, --projects <regex>, --days <n>)

Load and execute the `usage` skill (Skill tool, skill: "usage"):

**Standard mode (no arguments):**
1. Run the analyzer script (Step 1 of the skill) with `--out` pointing at the session scratchpad, passing through any `--projects` / `--days` arguments
2. Publish/redeploy the dashboard Artifact to the stable URL from `~/.claude/claude-usage-state.json` (Step 3)
3. Report the URL + headline numbers (Step 4)

**Deep mode (`--deep` present in $ARGUMENTS):**
1. Run the analyzer with `--deep`
2. Analyze `deep-manifest.json` prompts against the skill's anti-pattern checklist, write `findings.json` (Step 2)
3. Re-run the analyzer with `--findings findings.json`
4. Publish/redeploy the dashboard and report, leading with the top prompt-improvement findings
