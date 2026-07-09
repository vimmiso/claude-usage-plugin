#!/usr/bin/env node
/**
 * usage — Claude Code token usage & cost analyzer.
 *
 * Scans Claude Code session transcripts (~/.claude/projects/<dir>/*.jsonl),
 * aggregates token usage + estimated cost, and emits:
 *   usage-data.json    — full aggregate data
 *   dashboard.html     — self-contained dashboard (publish via Artifact tool)
 *   deep-manifest.json — (with --deep) user prompts of the costliest sessions,
 *                        for prompt-quality analysis by Claude
 *
 * Usage:
 *   node analyze-usage.mjs --out <dir> [--projects <regex>] [--days <n>]
 *                          [--deep] [--findings <findings.json>]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------- args ----------
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}
const OUT_DIR = path.resolve(arg('out', '.'));
const PROJECT_RE = new RegExp(arg('projects', '.'), 'i');
const DAYS = parseInt(arg('days', '30'), 10);
const DEEP = args.includes('--deep');
const FINDINGS_PATH = arg('findings', null);

// ---------- pricing ($ per MTok input/output; cache write 5m=1.25x, 1h=2x, read=0.1x input) ----------
const PRICING = [
  { re: /fable|mythos/i, inp: 10, out: 50 },
  { re: /opus-4-[01](?![0-9])/i, inp: 15, out: 75 },
  { re: /opus-3|3-opus/i, inp: 15, out: 75 },
  { re: /opus/i, inp: 5, out: 25 },
  { re: /sonnet/i, inp: 3, out: 15 },
  { re: /haiku-3|3-5-haiku/i, inp: 0.8, out: 4 },
  { re: /haiku/i, inp: 1, out: 5 },
];
function priceFor(model) {
  const p = PRICING.find((p) => p.re.test(model || ''));
  return p || { inp: 5, out: 25 }; // unknown model: assume Opus-tier
}
function costOf(model, u) {
  const p = priceFor(model);
  const w5 = u.cacheWrite5m, w1 = u.cacheWrite1h;
  return (
    (u.input * p.inp +
      w5 * p.inp * 1.25 +
      w1 * p.inp * 2 +
      u.cacheRead * p.inp * 0.1 +
      u.output * p.out) / 1e6
  );
}

// ---------- scan ----------
const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
const projectDirs = fs.existsSync(projectsRoot)
  ? fs.readdirSync(projectsRoot).filter((d) => PROJECT_RE.test(d) &&
      fs.statSync(path.join(projectsRoot, d)).isDirectory())
  : [];

const SYSTEM_TAG_RE = /^\s*<(ide_opened_file|ide_selection|system-reminder|command-name|command-message|command-args|local-command|task-notification|bash-(input|stdout|stderr))/;

function userPromptText(message) {
  // Returns the human-typed prompt text, or null if this user entry is
  // tool results / IDE noise / harness-injected content.
  const c = message?.content;
  const texts = [];
  if (typeof c === 'string') texts.push(c);
  else if (Array.isArray(c)) {
    for (const block of c) {
      if (block.type === 'tool_result') return null;
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
  }
  const real = texts.map((t) => t.trim()).filter((t) => t && !SYSTEM_TAG_RE.test(t));
  return real.length ? real.join('\n') : null;
}

const sessions = new Map(); // sessionId -> session record
const seenUsage = new Set(); // message.id + requestId dedupe

for (const dir of projectDirs) {
  const dirPath = path.join(projectsRoot, dir);
  for (const file of fs.readdirSync(dirPath)) {
    if (!file.endsWith('.jsonl')) continue;
    const sessionId = file.replace(/\.jsonl$/, '');
    let raw;
    try { raw = fs.readFileSync(path.join(dirPath, file), 'utf8'); } catch { continue; }

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e.timestamp) continue;

      let s = sessions.get(sessionId);
      if (!s) {
        s = {
          sessionId, project: dir, file: path.join(dirPath, file),
          firstTs: e.timestamp, lastTs: e.timestamp,
          branch: null, title: null, prompts: 0, promptTexts: [],
          assistantMsgs: 0, toolCalls: {}, models: {},
          usage: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
          cost: 0, hasSidechain: false,
        };
        sessions.set(sessionId, s);
      }
      if (e.timestamp < s.firstTs) s.firstTs = e.timestamp;
      if (e.timestamp > s.lastTs) s.lastTs = e.timestamp;
      if (e.gitBranch && !s.branch) s.branch = e.gitBranch;
      if (e.isSidechain) s.hasSidechain = true;

      if (e.type === 'user' && !e.isSidechain && !e.isMeta) {
        const text = userPromptText(e.message);
        if (text) {
          s.prompts++;
          s.promptTexts.push({ ts: e.timestamp, text: text.slice(0, 4000) });
          if (!s.title) s.title = text.replace(/\s+/g, ' ').slice(0, 140);
        }
      }

      if (e.type === 'assistant' && e.message?.usage) {
        const u = e.message.usage;
        const key = `${e.message.id || ''}:${e.requestId || ''}`;
        if (e.message.id && seenUsage.has(key)) continue; // streamed duplicates
        if (e.message.id) seenUsage.add(key);
        const model = e.message.model || 'unknown';
        if (model === '<synthetic>') continue;

        const cc = u.cache_creation || {};
        const w5 = cc.ephemeral_5m_input_tokens ?? (u.cache_creation_input_tokens || 0);
        const w1 = cc.ephemeral_1h_input_tokens ?? 0;
        const rec = {
          input: u.input_tokens || 0,
          cacheWrite5m: cc.ephemeral_5m_input_tokens != null ? w5 : (u.cache_creation_input_tokens || 0),
          cacheWrite1h: w1,
          cacheRead: u.cache_read_input_tokens || 0,
          output: u.output_tokens || 0,
        };
        s.usage.input += rec.input;
        s.usage.cacheWrite5m += rec.cacheWrite5m;
        s.usage.cacheWrite1h += rec.cacheWrite1h;
        s.usage.cacheRead += rec.cacheRead;
        s.usage.output += rec.output;
        s.assistantMsgs++;
        const m = (s.models[model] ||= { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, msgs: 0 });
        m.input += rec.input; m.cacheWrite5m += rec.cacheWrite5m; m.cacheWrite1h += rec.cacheWrite1h;
        m.cacheRead += rec.cacheRead; m.output += rec.output; m.msgs++;

        if (Array.isArray(e.message.content)) {
          for (const b of e.message.content) {
            if (b.type === 'tool_use' && b.name) s.toolCalls[b.name] = (s.toolCalls[b.name] || 0) + 1;
          }
        }
      }
    }
  }
}

// ---------- aggregate ----------
const allSessions = [...sessions.values()].filter((s) => s.assistantMsgs > 0 || s.prompts > 0);
for (const s of allSessions) {
  s.cost = Object.entries(s.models).reduce((acc, [model, u]) => acc + costOf(model, u), 0);
  s.totalTokens = s.usage.input + s.usage.cacheWrite5m + s.usage.cacheWrite1h + s.usage.cacheRead + s.usage.output;
}
allSessions.sort((a, b) => b.cost - a.cost);

function sumUsage(list) {
  return list.reduce((acc, s) => {
    acc.input += s.usage.input; acc.cacheWrite5m += s.usage.cacheWrite5m;
    acc.cacheWrite1h += s.usage.cacheWrite1h; acc.cacheRead += s.usage.cacheRead;
    acc.output += s.usage.output; acc.cost += s.cost;
    acc.prompts += s.prompts; acc.sessions += 1;
    return acc;
  }, { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, cost: 0, prompts: 0, sessions: 0 });
}

const totals = sumUsage(allSessions);
totals.totalTokens = totals.input + totals.cacheWrite5m + totals.cacheWrite1h + totals.cacheRead + totals.output;
const promptedInput = totals.input + totals.cacheWrite5m + totals.cacheWrite1h + totals.cacheRead;
totals.cacheHitRate = promptedInput ? totals.cacheRead / promptedInput : 0;
// savings = what cacheRead tokens would have cost at full input price minus what they cost at 0.1x (weighted per model)
let savings = 0;
for (const s of allSessions) {
  for (const [model, u] of Object.entries(s.models)) {
    savings += (u.cacheRead * priceFor(model).inp * 0.9) / 1e6;
  }
}
totals.cacheSavings = savings;

const byProject = {};
for (const s of allSessions) {
  (byProject[s.project] ||= []).push(s);
}
const projectRows = Object.entries(byProject).map(([name, list]) => {
  const u = sumUsage(list);
  return { name, ...u, totalTokens: u.input + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead + u.output };
}).sort((a, b) => b.cost - a.cost);

const byModel = {};
for (const s of allSessions) {
  for (const [model, u] of Object.entries(s.models)) {
    const m = (byModel[model] ||= { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, msgs: 0, cost: 0 });
    m.input += u.input; m.cacheWrite5m += u.cacheWrite5m; m.cacheWrite1h += u.cacheWrite1h;
    m.cacheRead += u.cacheRead; m.output += u.output; m.msgs += u.msgs;
    m.cost += costOf(model, u);
  }
}
const modelRows = Object.entries(byModel).map(([name, u]) => ({
  name, ...u, totalTokens: u.input + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead + u.output,
})).sort((a, b) => b.cost - a.cost);

// daily (local dates)
const byDay = {};
for (const s of allSessions) {
  const day = new Date(s.firstTs).toLocaleDateString('sv-SE'); // YYYY-MM-DD local
  const d = (byDay[day] ||= { cost: 0, tokens: 0, sessions: 0, prompts: 0 });
  d.cost += s.cost; d.tokens += s.totalTokens; d.sessions += 1; d.prompts += s.prompts;
}
const dayKeys = [];
{
  const today = new Date();
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    dayKeys.push(d.toLocaleDateString('sv-SE'));
  }
}
const dailyRows = dayKeys.map((day) => ({ day, ...(byDay[day] || { cost: 0, tokens: 0, sessions: 0, prompts: 0 }) }));

const topSessions = allSessions.slice(0, 15).map((s) => ({
  sessionId: s.sessionId, project: s.project, branch: s.branch,
  date: s.firstTs, title: s.title || '(no user prompt — automated/agent session)',
  prompts: s.prompts, totalTokens: s.totalTokens, cost: s.cost,
  cacheRead: s.usage.cacheRead, output: s.usage.output,
  models: Object.keys(s.models),
  topTools: Object.entries(s.toolCalls).sort((a, b) => b[1] - a[1]).slice(0, 5),
}));

const generatedAt = new Date().toISOString();
const data = {
  generatedAt, scope: { projectsRoot, matchedDirs: projectDirs, filter: PROJECT_RE.source, days: DAYS },
  totals, projects: projectRows, models: modelRows, daily: dailyRows, topSessions,
};

// findings (prompt analysis, written by Claude in --deep mode)
let findings = null;
if (FINDINGS_PATH && fs.existsSync(FINDINGS_PATH)) {
  try { findings = JSON.parse(fs.readFileSync(FINDINGS_PATH, 'utf8')); } catch { /* ignore */ }
}

// ---------- outputs ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'usage-data.json'), JSON.stringify(data, null, 2));

if (DEEP) {
  const manifest = allSessions.slice(0, 12).map((s) => ({
    sessionId: s.sessionId, project: s.project, branch: s.branch, date: s.firstTs,
    cost: +s.cost.toFixed(2), totalTokens: s.totalTokens, prompts: s.prompts,
    file: s.file,
    promptTexts: s.promptTexts.slice(0, 30),
    topTools: Object.entries(s.toolCalls).sort((a, b) => b[1] - a[1]).slice(0, 8),
  }));
  fs.writeFileSync(path.join(OUT_DIR, 'deep-manifest.json'), JSON.stringify(manifest, null, 2));
}

// ---------- dashboard ----------
const html = buildDashboard(data, findings);
fs.writeFileSync(path.join(OUT_DIR, 'dashboard.html'), html);

// console summary for Claude
console.log(JSON.stringify({
  ok: true,
  out: OUT_DIR,
  files: ['usage-data.json', 'dashboard.html', ...(DEEP ? ['deep-manifest.json'] : [])],
  summary: {
    sessions: totals.sessions,
    prompts: totals.prompts,
    totalTokens: totals.totalTokens,
    estCostUSD: +totals.cost.toFixed(2),
    cacheHitRate: +(totals.cacheHitRate * 100).toFixed(1) + '%',
    cacheSavingsUSD: +totals.cacheSavings.toFixed(2),
    projects: projectRows.map((p) => ({ name: p.name, costUSD: +p.cost.toFixed(2) })),
    models: modelRows.map((m) => ({ name: m.name, costUSD: +m.cost.toFixed(2) })),
    findingsEmbedded: !!findings,
  },
}, null, 2));

// ======================================================================
function buildDashboard(data, findings) {
  const payload = JSON.stringify({ data, findings }).replace(/</g, '\\u003c');
  return `<title>Claude Usage</title>
<style>
  :root {
    --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e;
    --muted: #898781; --grid: #e1e0d9; --axis: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --s1: #2a78d6; --s2: #1baf7a; --s3: #eda100; --s4: #008300;
    --s5: #4a3aa7; --s6: #e34948; --s7: #e87ba4; --s8: #eb6834;
    --good: #006300; --warn: #b97f00; --serious: #b35325; --critical: #d03b3b;
    --seq-strong: #1c5cab;
  }
  @media (prefers-color-scheme: dark) { :root {
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7;
    --muted: #898781; --grid: #2c2c2a; --axis: #383835;
    --border: rgba(255,255,255,0.10);
    --s1: #3987e5; --s2: #199e70; --s3: #c98500; --s4: #008300;
    --s5: #9085e9; --s6: #e66767; --s7: #d55181; --s8: #d95926;
    --good: #0ca30c; --warn: #fab219; --serious: #ec835a; --critical: #d03b3b;
    --seq-strong: #6da7ec;
  }}
  :root[data-theme="dark"] {
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7;
    --muted: #898781; --grid: #2c2c2a; --axis: #383835;
    --border: rgba(255,255,255,0.10);
    --s1: #3987e5; --s2: #199e70; --s3: #c98500; --s4: #008300;
    --s5: #9085e9; --s6: #e66767; --s7: #d55181; --s8: #d95926;
    --good: #0ca30c; --warn: #fab219; --serious: #ec835a; --critical: #d03b3b;
    --seq-strong: #6da7ec;
  }
  :root[data-theme="light"] {
    --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e;
    --muted: #898781; --grid: #e1e0d9; --axis: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --s1: #2a78d6; --s2: #1baf7a; --s3: #eda100; --s4: #008300;
    --s5: #4a3aa7; --s6: #e34948; --s7: #e87ba4; --s8: #eb6834;
    --good: #006300; --warn: #b97f00; --serious: #b35325; --critical: #d03b3b;
    --seq-strong: #1c5cab;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--page); color: var(--ink);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 32px 24px 64px; }
  header .eyebrow {
    font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--muted); font-weight: 600;
  }
  header h1 { margin: 4px 0 2px; font-size: 26px; letter-spacing: -0.01em; text-wrap: balance; }
  header .meta { color: var(--ink-2); font-size: 13px; }
  header .meta code { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 12px; margin: 24px 0; }
  .tile {
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 14px 16px;
  }
  .tile .label { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
  .tile .value { font-size: 26px; font-weight: 650; margin-top: 4px; letter-spacing: -0.01em; }
  .tile .sub { font-size: 12px; color: var(--ink-2); margin-top: 2px; }
  .tile .value.good { color: var(--good); }

  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 820px) { .grid2 { grid-template-columns: 1fr; } }

  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 18px 18px 14px; margin: 12px 0;
  }
  .card h2 { margin: 0 0 2px; font-size: 15px; font-weight: 650; }
  .card .sub { color: var(--ink-2); font-size: 12.5px; margin-bottom: 12px; }
  .chart-scroll { overflow-x: auto; }
  svg text { font: 11px system-ui, -apple-system, "Segoe UI", sans-serif; fill: var(--muted); }
  svg .val { fill: var(--ink-2); font-variant-numeric: tabular-nums; }
  svg .cat { fill: var(--ink); font-size: 12px; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
       color: var(--muted); font-weight: 600; padding: 6px 10px; border-bottom: 1px solid var(--grid); }
  td { padding: 8px 10px; border-bottom: 1px solid var(--grid); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .snippet { color: var(--ink); max-width: 420px; }
  .dim { color: var(--muted); font-size: 12px; }
  .chip { display: inline-block; font-size: 11px; padding: 1px 7px; border: 1px solid var(--border);
          border-radius: 999px; color: var(--ink-2); background: transparent; margin-right: 4px; }
  .table-wrap { overflow-x: auto; }

  .finding { border-left: 3px solid var(--warn); padding: 10px 14px; margin: 10px 0;
             background: color-mix(in srgb, var(--surface) 92%, var(--warn) 8%); border-radius: 0 6px 6px 0; }
  .finding.high { border-left-color: var(--critical); background: color-mix(in srgb, var(--surface) 93%, var(--critical) 7%); }
  .finding.low { border-left-color: var(--s1); background: color-mix(in srgb, var(--surface) 94%, var(--s1) 6%); }
  .finding h3 { margin: 0 0 4px; font-size: 13.5px; }
  .finding .sev { font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 700; color: var(--ink-2); }
  .finding p { margin: 4px 0; font-size: 13px; color: var(--ink-2); }
  .finding .rewrite { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px;
                      background: var(--page); border: 1px solid var(--border); border-radius: 4px;
                      padding: 8px 10px; margin-top: 6px; white-space: pre-wrap; color: var(--ink); }
  .empty { color: var(--muted); font-size: 13px; padding: 12px 0; }
  .tooltip {
    position: fixed; pointer-events: none; z-index: 10; display: none;
    background: var(--ink); color: var(--page); padding: 6px 10px; border-radius: 4px;
    font-size: 12px; font-variant-numeric: tabular-nums; box-shadow: 0 2px 10px rgba(0,0,0,0.25);
  }
  footer { margin-top: 28px; color: var(--muted); font-size: 12px; }
</style>
<div class="wrap">
  <header>
    <div class="eyebrow">Claude Code telemetry</div>
    <h1>Token usage &amp; prompt efficiency</h1>
    <div class="meta" id="meta"></div>
  </header>
  <div class="tiles" id="tiles"></div>
  <div class="card">
    <h2>Daily estimated cost</h2>
    <div class="sub" id="daily-sub"></div>
    <div class="chart-scroll" id="daily-chart"></div>
  </div>
  <div class="grid2">
    <div class="card">
      <h2>Cost by model</h2>
      <div class="sub">Estimated USD, all time in scanned transcripts</div>
      <div id="model-chart"></div>
    </div>
    <div class="card">
      <h2>Cost by project</h2>
      <div class="sub">Claude Code project folders matching the scope filter</div>
      <div id="project-chart"></div>
    </div>
  </div>
  <div class="card">
    <h2>Token composition</h2>
    <div class="sub">Where input tokens come from — cache reads are ~10× cheaper than fresh input</div>
    <div id="composition"></div>
  </div>
  <div class="card">
    <h2>Most expensive sessions</h2>
    <div class="sub">Top sessions by estimated cost — candidates for prompt improvement</div>
    <div class="table-wrap"><table id="sessions"></table></div>
  </div>
  <div class="card">
    <h2>Prompt insights</h2>
    <div class="sub">Patterns found in the costliest sessions, with suggested rewrites</div>
    <div id="findings"></div>
  </div>
  <footer>
    Costs are estimates from published per-token API pricing (cache writes 1.25×/2×, cache reads 0.1× input).
    Refresh with <code>/usage:dash</code>; run <code>/usage:dash --deep</code> to regenerate prompt insights.
  </footer>
</div>
<div class="tooltip" id="tip"></div>
<script>
const { data, findings } = ${payload};
const $ = (id) => document.getElementById(id);
const fmt$ = (v) => '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2));
const fmtTok = (v) => v >= 1e9 ? (v/1e9).toFixed(2)+'B' : v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(1)+'K' : String(v);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// header
$('meta').innerHTML = 'Generated ' + new Date(data.generatedAt).toLocaleString() +
  ' · scanning <code>' + esc(data.scope.matchedDirs.join(', ')) + '</code>';

// tiles
const t = data.totals;
$('tiles').innerHTML = [
  ['Est. total cost', fmt$(t.cost), t.sessions + ' sessions'],
  ['Total tokens', fmtTok(t.totalTokens), fmtTok(t.output) + ' output'],
  ['User prompts', String(t.prompts), t.prompts ? fmt$(t.cost / t.prompts) + ' avg / prompt' : ''],
  ['Cache hit rate', (t.cacheHitRate * 100).toFixed(1) + '%', 'of prompt tokens served from cache', 'good'],
  ['Cache savings', fmt$(t.cacheSavings), 'vs. uncached input pricing', 'good'],
].map(([l, v, s, cls]) =>
  '<div class="tile"><div class="label">' + l + '</div><div class="value ' + (cls||'') + '">' + v +
  '</div><div class="sub">' + s + '</div></div>').join('');

// tooltip helpers
const tip = $('tip');
function showTip(ev, html) { tip.innerHTML = html; tip.style.display = 'block'; moveTip(ev); }
function moveTip(ev) { tip.style.left = (ev.clientX + 14) + 'px'; tip.style.top = (ev.clientY - 10) + 'px'; }
function hideTip() { tip.style.display = 'none'; }

// daily bar chart
(function () {
  const rows = data.daily;
  const active = rows.filter((r) => r.cost > 0).length;
  $('daily-sub').textContent = 'Last ' + rows.length + ' days · ' + active + ' active days';
  const W = Math.max(720, rows.length * 24), H = 190, padL = 44, padB = 26, padT = 10;
  const max = Math.max(...rows.map((r) => r.cost), 0.01);
  const bw = (W - padL - 8) / rows.length;
  let bars = '', ticks = '';
  const gridN = 4;
  for (let g = 0; g <= gridN; g++) {
    const y = padT + (H - padT - padB) * (1 - g / gridN);
    ticks += '<line x1="' + padL + '" x2="' + W + '" y1="' + y + '" y2="' + y + '" stroke="var(--grid)" stroke-width="1"/>' +
      '<text x="' + (padL - 6) + '" y="' + (y + 3.5) + '" text-anchor="end" class="val">' + fmt$(max * g / gridN) + '</text>';
  }
  rows.forEach((r, i) => {
    const h = Math.max(r.cost > 0 ? 2 : 0, (H - padT - padB) * (r.cost / max));
    const x = padL + i * bw + 2, y = H - padB - h;
    bars += '<rect data-i="' + i + '" x="' + x + '" y="' + y + '" width="' + Math.max(2, bw - 4) +
      '" height="' + h + '" rx="2" fill="var(--s1)"/>';
    if (i % Math.ceil(rows.length / 15) === 0)
      bars += '<text x="' + (x + bw / 2 - 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + r.day.slice(5) + '</text>';
  });
  $('daily-chart').innerHTML = '<svg width="' + W + '" height="' + H + '" role="img" aria-label="Daily estimated cost">' +
    ticks + '<line x1="' + padL + '" x2="' + W + '" y1="' + (H - padB) + '" y2="' + (H - padB) + '" stroke="var(--axis)"/>' + bars + '</svg>';
  $('daily-chart').addEventListener('mousemove', (ev) => {
    const r = ev.target.closest('rect'); if (!r) return hideTip();
    const d = rows[+r.dataset.i];
    showTip(ev, '<b>' + d.day + '</b><br>' + fmt$(d.cost) + ' · ' + fmtTok(d.tokens) + ' tok · ' + d.sessions + ' sessions · ' + d.prompts + ' prompts');
  });
  $('daily-chart').addEventListener('mouseleave', hideTip);
})();

// horizontal bar charts (model / project)
function hbars(el, rows, labelOf) {
  const W = 480, rowH = 34, padL = 4, padT = 4;
  const max = Math.max(...rows.map((r) => r.cost), 0.01);
  const H = padT + rows.length * rowH + 4;
  let out = '';
  rows.forEach((r, i) => {
    const y = padT + i * rowH;
    const w = Math.max(3, (W - 130) * (r.cost / max));
    out += '<text x="' + padL + '" y="' + (y + 12) + '" class="cat">' + esc(labelOf(r)) + '</text>' +
      '<rect data-i="' + i + '" x="' + padL + '" y="' + (y + 17) + '" width="' + w + '" height="10" rx="2" fill="var(--s' + ((i % 8) + 1) + ')"/>' +
      '<text x="' + (padL + w + 8) + '" y="' + (y + 26) + '" class="val">' + fmt$(r.cost) + ' · ' + fmtTok(r.totalTokens) + ' tok</text>';
  });
  el.innerHTML = '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" role="img">' + out + '</svg>';
}
hbars($('model-chart'), data.models, (r) => r.name);
hbars($('project-chart'), data.projects, (r) => r.name.replace(/^C--/i, '').replace(/-/g, '/'));

// token composition (single stacked bar)
(function () {
  const t = data.totals;
  const parts = [
    ['Cache reads', t.cacheRead, 'var(--s1)'],
    ['Cache writes', t.cacheWrite5m + t.cacheWrite1h, 'var(--s2)'],
    ['Fresh input', t.input, 'var(--s3)'],
    ['Output', t.output, 'var(--s5)'],
  ];
  const total = parts.reduce((a, p) => a + p[1], 0) || 1;
  let x = 0, segs = '', legend = '';
  const W = 720, H = 30;
  parts.forEach(([name, v, color]) => {
    const w = (W * v) / total;
    if (w > 0.5) segs += '<rect x="' + (x + 1) + '" y="0" width="' + Math.max(1, w - 2) + '" height="' + H + '" rx="3" fill="' + color + '"><title>' + name + ': ' + fmtTok(v) + ' (' + ((v / total) * 100).toFixed(1) + '%)</title></rect>';
    x += w;
    legend += '<span class="chip"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:' + color + ';margin-right:5px"></span>' + name + ' · ' + fmtTok(v) + ' (' + ((v / total) * 100).toFixed(1) + '%)</span>';
  });
  $('composition').innerHTML = '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" style="max-width:' + W + 'px">' + segs + '</svg><div style="margin-top:10px">' + legend + '</div>';
})();

// sessions table
(function () {
  const rows = data.topSessions;
  let html = '<tr><th>Date</th><th>Session</th><th class="num">Prompts</th><th class="num">Tokens</th><th class="num">Est. cost</th></tr>';
  for (const s of rows) {
    html += '<tr><td class="dim" style="white-space:nowrap">' + new Date(s.date).toLocaleDateString() + '</td>' +
      '<td><div class="snippet">' + esc(s.title) + '</div><div class="dim">' +
      esc(s.project.replace(/^C--/i, '')) + (s.branch ? ' · ' + esc(s.branch) : '') +
      (s.models.length ? ' · ' + esc(s.models.map((m) => m.replace(/^claude-/, '')).join(', ')) : '') + '</div></td>' +
      '<td class="num">' + s.prompts + '</td>' +
      '<td class="num">' + fmtTok(s.totalTokens) + '</td>' +
      '<td class="num"><b>' + fmt$(s.cost) + '</b></td></tr>';
  }
  $('sessions').innerHTML = html;
})();

// findings
(function () {
  const el = $('findings');
  if (!findings || !findings.items || !findings.items.length) {
    el.innerHTML = '<div class="empty">No prompt analysis embedded yet — run <b>/usage:dash --deep</b> to analyze the costliest sessions and populate this section.</div>';
    return;
  }
  const sev = { high: 'high', medium: '', low: 'low' };
  el.innerHTML = (findings.summary ? '<p style="font-size:13px;color:var(--ink-2)">' + esc(findings.summary) + '</p>' : '') +
    findings.items.map((f) =>
      '<div class="finding ' + (sev[f.severity] ?? '') + '">' +
      '<div class="sev">' + esc(f.severity || 'medium') + (f.estImpact ? ' · ' + esc(f.estImpact) : '') + '</div>' +
      '<h3>' + esc(f.title) + '</h3>' +
      '<p>' + esc(f.detail) + '</p>' +
      (f.example ? '<p class="dim">Example: “' + esc(f.example) + '”</p>' : '') +
      (f.rewrite ? '<div class="rewrite">' + esc(f.rewrite) + '</div>' : '') +
      '</div>').join('');
})();
</script>
`;
}
