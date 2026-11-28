// A/B summary for booster-ab.yml: per variant, games, score, Elo with a
// 95% interval from game pairs (colors swapped within a pair), and an SPRT
// verdict (H0: elo <= elo0, H1: elo >= elo1, alpha = beta = 0.05).
//
//   node booster/tools/ab-summary.cjs <dir with <variant>/games-*.jsonl> [--elo0 0 --elo1 15] [--md out.md]
"use strict";
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const dir = args[0];
const elo0 = Number(opt("elo0", 0)), elo1 = Number(opt("elo1", 15)), mdOut = opt("md", null);

const expScore = (e) => 1 / (1 + 10 ** (-e / 400));
const toElo = (p) => -400 * Math.log10(1 / Math.min(Math.max(p, 1e-3), 1 - 1e-3) - 1);

function stats(games) {
  const n = games.length, w = games.filter((g) => g.scoreA === 1).length, d = games.filter((g) => g.scoreA === 0.5).length;
  const byPair = new Map();
  for (const g of games) byPair.set(g.pair, (byPair.get(g.pair) || []).concat(g.scoreA));
  const pairs = [...byPair.values()].filter((v) => v.length === 2).map((v) => (v[0] + v[1]) / 2);
  const N = pairs.length;
  const m = N ? pairs.reduce((s, x) => s + x, 0) / N : 0.5;
  const v = N > 1 ? pairs.reduce((s, x) => s + (x - m) ** 2, 0) / (N - 1) : 0.0625;
  const se = Math.sqrt(v / Math.max(1, N));
  const p = n ? (w + d / 2) / n : 0.5;
  // GSPRT on pair scores (normal approximation)
  const s0 = expScore(elo0), s1 = expScore(elo1);
  const llr = N > 1 && v > 0 ? (N * (s1 - s0) * (2 * m - s0 - s1)) / (2 * v) : 0;
  const A = Math.log(0.05 / 0.95), B = Math.log(0.95 / 0.05);
  const verdict = llr >= B ? `좋아짐 확정 (>= +${elo1})` : llr <= A ? `좋아지지 않음 확정 (<= +${elo0})` : "아직 판정 못 함";
  return { n, w, d, l: n - w - d, p, elo: toElo(p), lo: toElo(m - 1.96 * se), hi: toElo(m + 1.96 * se), pairs: N, llr, A, B, verdict, errors: games.filter((g) => g.error).length, fallbacks: games.reduce((s, g) => s + (g.stats?.fallbacks || 0), 0) };
}

const rows = [];
for (const name of fs.readdirSync(dir).sort()) {
  const sub = path.join(dir, name);
  if (!fs.statSync(sub).isDirectory()) continue;
  const games = fs.readdirSync(sub).filter((f) => f.endsWith(".jsonl")).flatMap((f) => fs.readFileSync(path.join(sub, f), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
  if (!games.length) { rows.push({ name, empty: true }); continue; }
  rows.push({ name, ...stats(games) });
}

const lines = [`| 실험 | 판수 | A 승/무/패 | 점수 | Elo [95%] | 판정 (SPRT ${elo0}/${elo1}) |`, "|---|---|---|---|---|---|"];
for (const r of rows) {
  if (r.empty) { lines.push(`| ${r.name} | 0 | - | - | - | 기록 없음 |`); continue; }
  lines.push(`| ${r.name} | ${r.n} | ${r.w}/${r.d}/${r.l} | ${(r.p * 100).toFixed(1)}% | ${r.elo >= 0 ? "+" : ""}${r.elo.toFixed(0)} [${r.lo.toFixed(0)}, ${r.hi.toFixed(0)}] | ${r.verdict} (LLR ${r.llr.toFixed(2)}) |`);
}
const notes = rows.filter((r) => !r.empty && (r.errors || r.fallbacks)).map((r) => `- ${r.name}: 오류 ${r.errors}판, 대체 수 ${r.fallbacks}번`);
const md = lines.join("\n") + (notes.length ? "\n\n" + notes.join("\n") : "");
console.log(md);
if (mdOut) fs.writeFileSync(mdOut, md + "\n");
// plain text for a Discord message (tables do not render there)
const plain = rows.map((r) => r.empty ? `${r.name}: 기록 없음` : `${r.name}: ${r.n}판, Elo ${r.elo >= 0 ? "+" : ""}${r.elo.toFixed(0)} [${r.lo.toFixed(0)}, ${r.hi.toFixed(0)}], ${r.verdict}`).join("\n");
fs.writeFileSync(path.join(dir, "..", "ab-plain.txt"), plain + "\n");
