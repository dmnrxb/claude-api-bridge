#!/usr/bin/env node
// Writes docs/architecture.svg and docs/architecture-dark.svg.
// Both come from the same layout so they can never drift apart.
//
//   node scripts/build-diagram.mjs

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const W = 1284;
const H = 648;

const FONT = "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const THEMES = {
  light: {
    file: 'architecture.svg',
    bg: '#ffffff',
    outerFill: '#f8fafc',
    outerStroke: '#cbd5e1',
    innerFill: '#ffffff',
    innerStroke: '#94a3b8',
    boxFill: '#ffffff',
    boxStroke: '#cbd5e1',
    stepFill: '#f1f5f9',
    stepStroke: '#e2e8f0',
    badgeFill: '#2563eb',
    badgeText: '#ffffff',
    dbFill: '#eef2ff',
    dbStroke: '#c7d2fe',
    apiFill: '#fff7ed',
    apiStroke: '#fdba74',
    text: '#0f172a',
    muted: '#64748b',
    line: '#94a3b8',
  },
  dark: {
    file: 'architecture-dark.svg',
    bg: '#0d1117',
    outerFill: '#161b22',
    outerStroke: '#30363d',
    innerFill: '#0d1117',
    innerStroke: '#484f58',
    boxFill: '#161b22',
    boxStroke: '#30363d',
    stepFill: '#161b22',
    stepStroke: '#30363d',
    badgeFill: '#388bfd',
    badgeText: '#0d1117',
    dbFill: '#12233d',
    dbStroke: '#1f4b7f',
    apiFill: '#2d1e12',
    apiStroke: '#7d4a1d',
    text: '#e6edf3',
    muted: '#8b949e',
    line: '#6e7681',
  },
};

const STEPS = [
  ['Check the key', 'x-api-key or Bearer, matched against a stored hash'],
  ['Apply the limits', 'per key, requests per minute and per day'],
  ['Translate the request', 'the message history is flattened into one prompt'],
  ['Pick an account', 'priority order, the next one if this one is out'],
  ['Run claude -p', 'file and shell tools off, web search on, own process'],
  ['Answer', 'JSON, or server sent events while the text arrives'],
];

const STEP_X = 488;
const STEP_W = 470;
const STEP_H = 46;
const STEP_GAP = 12;
const STEP_TOP = 108;
const RAIL_X = 470;

const stepY = (i) => STEP_TOP + i * (STEP_H + STEP_GAP);
const stepMid = (i) => stepY(i) + STEP_H / 2;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function text(x, y, value, { size = 12, fill, weight = 400, anchor = 'start', font = FONT } = {}) {
  return `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(value)}</text>`;
}

function box(x, y, w, h, { fill, stroke, r = 10, dash = null, width = 1.5 }) {
  const d = dash ? ` stroke-dasharray="${dash}"` : '';
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${width}"${d}/>`;
}

function arrow(x1, y1, x2, y2, stroke, { dash = null, marker = 'head' } = {}) {
  const d = dash ? ` stroke-dasharray="${dash}"` : '';
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="1.5"${d} marker-end="url(#${marker})"/>`;
}

function render(t) {
  const parts = [];
  const push = (...items) => parts.push(...items);

  push(`<rect width="${W}" height="${H}" fill="${t.bg}"/>`);

  // -- left column: who calls, and what sits in front ----------------------

  push(text(16, 86, 'POST /v1/chat/completions', { size: 12, fill: t.muted, font: MONO }));

  push(box(16, 100, 164, 120, { fill: t.boxFill, stroke: t.boxStroke }));
  push(text(36, 132, 'Your tools', { size: 14, weight: 600, fill: t.text }));
  ['n8n', 'Open WebUI', 'curl', 'any OpenAI SDK'].forEach((line, i) => {
    push(text(36, 156 + i * 18, line, { size: 12, fill: t.muted }));
  });

  push(box(224, 100, 156, 120, { fill: t.boxFill, stroke: t.boxStroke }));
  push(text(244, 132, 'Reverse proxy', { size: 14, weight: 600, fill: t.text }));
  push(text(244, 156, 'nginx, Traefik or', { size: 12, fill: t.muted }));
  push(text(244, 174, 'the bundled Caddy', { size: 12, fill: t.muted }));
  push(text(244, 200, 'TLS ends here', { size: 11, fill: t.muted }));

  push(arrow(184, 145, 218, 145, t.line));
  push(arrow(218, 171, 184, 171, t.line, { dash: '4 3' }));
  push(arrow(384, 145, 414, 145, t.line));
  push(arrow(414, 171, 384, 171, t.line, { dash: '4 3' }));

  push(text(16, 254, 'A solid arrow carries the request,', { size: 11, fill: t.muted }));
  push(text(16, 272, 'a dashed one carries the answer back.', { size: 11, fill: t.muted }));

  // -- the container -------------------------------------------------------

  push(box(420, 24, 580, 584, { fill: t.outerFill, stroke: t.outerStroke, r: 14, dash: '7 5' }));
  push(text(436, 48, 'Docker', { size: 13, weight: 600, fill: t.muted }));

  push(box(440, 64, 540, 520, { fill: t.innerFill, stroke: t.innerStroke, r: 12 }));
  push(text(462, 92, 'claude-api-bridge', { size: 13, weight: 600, fill: t.text, font: MONO }));

  STEPS.forEach(([title, detail], i) => {
    const y = stepY(i);
    push(box(STEP_X, y, STEP_W, STEP_H, { fill: t.stepFill, stroke: t.stepStroke, r: 8, width: 1 }));
    push(`<circle cx="${STEP_X + 22}" cy="${y + 23}" r="11" fill="${t.badgeFill}"/>`);
    push(text(STEP_X + 22, y + 27, String(i + 1), { size: 12, weight: 700, fill: t.badgeText, anchor: 'middle' }));
    push(text(STEP_X + 44, y + 20, title, { size: 13, weight: 600, fill: t.text }));
    push(text(STEP_X + 44, y + 36, detail, { size: 11, fill: t.muted }));

    // A small arrowhead in the gap, so the order reads top to bottom.
    if (i < STEPS.length - 1) {
      const gy = y + STEP_H;
      const cx = STEP_X + STEP_W / 2;
      push(`<path d="M ${cx - 4} ${gy + 3} L ${cx + 4} ${gy + 3} L ${cx} ${gy + 9} Z" fill="${t.line}"/>`);
    }
  });

  // -- the database --------------------------------------------------------

  push(arrow(RAIL_X, stepMid(0), RAIL_X, 474, t.line, { dash: '4 3' }));
  [0, 1, 3, 5].forEach((i) => {
    push(`<line x1="${RAIL_X}" y1="${stepMid(i)}" x2="${STEP_X}" y2="${stepMid(i)}" stroke="${t.line}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
  });

  push(box(462, 478, 496, 76, { fill: t.dbFill, stroke: t.dbStroke, r: 10 }));
  push(text(484, 504, 'bridge.db', { size: 13, weight: 600, fill: t.text, font: MONO }));
  push(text(484, 524, 'API keys, account tokens, one row for every request', { size: 11, fill: t.muted }));
  push(text(484, 542, 'kept in a volume on the host, survives a rebuild', { size: 11, fill: t.muted }));

  push(box(16, 478, 340, 76, { fill: t.boxFill, stroke: t.boxStroke }));
  push(text(36, 504, 'claude-bridge', { size: 13, weight: 600, fill: t.text, font: MONO }));
  push(text(36, 524, 'keys add \u00b7 accounts add \u00b7 stats \u00b7 recent', { size: 11, fill: t.muted }));
  push(text(36, 542, 'runs on the host, no web interface', { size: 11, fill: t.muted }));

  push(`<line x1="366" y1="516" x2="452" y2="516" stroke="${t.line}" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#head)" marker-start="url(#head)"/>`);

  // -- upstream ------------------------------------------------------------

  push(box(1060, 325, 200, 76, { fill: t.apiFill, stroke: t.apiStroke }));
  push(text(1080, 356, 'api.anthropic.com', { size: 13, weight: 600, fill: t.text, font: MONO }));
  push(text(1080, 378, 'your Claude subscription', { size: 11, fill: t.muted }));

  push(arrow(962, 352, 1056, 352, t.line));
  push(arrow(1056, 376, 962, 376, t.line, { dash: '4 3' }));
  push(text(1009, 342, 'HTTPS', { size: 10, fill: t.muted, anchor: 'middle' }));

  // -- caption -------------------------------------------------------------

  push(text(16, 630, 'Every request starts its own Claude Code process. Nothing is kept between calls.', { size: 12, fill: t.muted }));

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="How Claude API Bridge handles a request">
<defs>
<marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M 0 0 L 10 5 L 0 10 z" fill="${t.line}"/>
</marker>
</defs>
${parts.join('\n')}
</svg>
`;
}

for (const theme of Object.values(THEMES)) {
  const out = join(ROOT, 'docs', theme.file);
  writeFileSync(out, render(theme));
  process.stdout.write(`wrote ${out}\n`);
}
