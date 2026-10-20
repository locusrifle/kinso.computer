#!/usr/bin/env node
// Usage: node analyze-native-profile.mjs native.jsonl
import { readFileSync } from 'node:fs';
const rows = readFileSync(process.argv[2], 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const profiles = new Map(), cpus = new Map();
for (const row of rows) {
  if (row.type === 'process') {
    const key = `${row.name} pid=${row.pid}`;
    const g = cpus.get(key) || { cpu: [], rss: 0, start: row.monoMs, end: row.monoMs };
    if (row.cpuPercent !== null) g.cpu.push(row.cpuPercent);
    g.rss = Math.max(g.rss, row.rssBytes); g.end = row.monoMs; cpus.set(key, g);
  }
  if (row.type !== 'profile') continue;
  const session = profiles.get(row.pid) || { events: [], groups: new Map() };
  session.events.push(row.data);
  for (const [key, g] of Object.entries(row.data.groups || {})) {
    const sum = session.groups.get(key) || { n: 0, sum: 0, max: 0, bins: Array(9).fill(0) };
    sum.n += g.n; sum.sum += g.sum; sum.max = Math.max(sum.max, g.max);
    g.bins.forEach((n, i) => sum.bins[i] += n); session.groups.set(key, sum);
  }
  profiles.set(row.pid, session);
}
const bounds = ['0–8', '8–16.7', '16.7–25', '25–33.4', '33.4–50', '50–100', '100–250', '250–500', '>500'];
const p95 = g => { let n = 0; for (let i = 0; i < g.bins.length; i++) { n += g.bins[i]; if (n >= g.n * .95) return bounds[i]; } return '?'; };
const fixed = n => Number.isFinite(n) ? n.toFixed(1) : '?';
for (const [pid, session] of profiles) {
  console.log(`\nNative locker pid ${pid}`);
  const event = name => session.events.find(e => e.event === name);
  const delta = (a, b, field) => { const x = event(a), y = event(b); if (x && y) console.log(`${a} → ${b}: ${fixed(y[field] - x[field])} ms`); };
  delta('native-start', 'native-locked', 'nativeMonoMs');
  delta('native-start', 'page-ready-native', 'nativeMonoMs');
  delta('page-load-request', 'document', 'nativeMonoMs');
  delta('document', 'module-ready', 'at');
  delta('module-ready', 'assets-decoded', 'at');
  delta('assets-decoded', 'painting-ready', 'at');
  delta('touch', 'box', 'at');
  for (const e of session.events.filter(e => ['document', 'context-ready', 'first-paint-submit', 'sky-first-submit', 'painting-ready', 'longtask-support'].includes(e.event))) console.log(JSON.stringify(e));
  console.log('Phase/measurement: count, mean ms, p95 bucket ms, max ms; bins [≤8,≤16.7,≤25,≤33.4,≤50,≤100,≤250,≤500,>500]');
  for (const [key, g] of session.groups) console.log(`${key}: ${g.n}, ${fixed(g.sum / g.n)}, ${p95(g)}, ${fixed(g.max)}; ${g.bins}`);
  for (const phase of ['approach', 'contact', 'ready']) {
    const groups = [...session.groups].filter(([k]) => k.startsWith(phase + ':') && ['skyAt-cpu', 'sky-draw-cpu', 'painting-cpu'].includes(k.split(':')[1]));
    groups.sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n);
    if (groups.length) console.log(`${phase}: largest measured CPU slice = ${groups[0][0]} (${fixed(groups[0][1].sum / groups[0][1].n)} ms/submit).`);
    const gap = session.groups.get(phase + ':raf-gap');
    if (gap && gap.bins.slice(5).reduce((a, b) => a + b, 0) > gap.n * .1) console.log(`${phase}: >10% rAF intervals exceed 50ms. Compare CPU slices and process CPU; low JS cost with long gaps implicates native scheduling/raster/GPU/compositor, not proven GPU attribution.`);
  }
}
console.log('\nProcesses (100% = one core; RSS not unique physical memory):');
for (const [key, g] of cpus) {
  g.cpu.sort((a, b) => a - b);
  console.log(`${key}: p95 CPU ${fixed(g.cpu[Math.floor(g.cpu.length * .95)])}%, peak RSS ${fixed(g.rss / 1048576)} MiB, observed ${fixed((g.end - g.start) / 1000)}s`);
}
if (!profiles.size) console.log('No instrumented lock yet: collect at the next user/coordinated lock. Process data alone cannot explain contact lag.');
console.log('\nFirst render includes lazy shader compilation, texture uploads and submission; it is not a separate compile timer or proof of visible presentation. JS timers measure CPU submission, not GPU completion. Native timestamps use monotonic time; page at is relative to its own origin. Contact reveal baseline clamps dt to 100ms: dropped frames can stretch its nominal duration. No density/physics changes in this diagnostic.');
