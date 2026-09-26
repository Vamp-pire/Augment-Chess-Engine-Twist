// Smoke run: N games per site-draft mode through the REAL playOneGame at a tiny depth.
//   node tools/site-draft/smoke.js [gamesPerMode=20] [--rules-always] [--modes=normal,chaos,grand,mix]
// Driver spawns one child per mode (the worker reads SELFPLAY_SITE_DRAFT at load), sequentially,
// so at most one node process runs at a time. Local-only sanity check, not a benchmark.
"use strict";
const { spawnSync } = require("child_process");
const argv = process.argv.slice(2);
const childMode = argv[0] === "--child" ? argv[1] : null;
if (!childMode) {
  const n = Number(argv.find((a) => /^\d+$/.test(a))) || 20;
  const extra = argv.includes("--rules-always") ? { SELFPLAY_RULE_PROB: "1" } : {};
  const modesArg = argv.find((a) => a.startsWith("--modes="));
  for (const mode of modesArg ? modesArg.slice(8).split(",") : ["normal", "chaos", "grand", "mix"]) {
    const r = spawnSync(process.execPath, [__filename, "--child", mode, String(n)], { env: { ...process.env, SELFPLAY_SITE_DRAFT: mode, ...extra }, encoding: "utf8" });
    process.stdout.write(r.stdout || "");
    if (r.status !== 0) { process.stderr.write(r.stderr || ""); process.exitCode = 1; }
  }
} else {
  const { playOneGame, makeRng } = require("../../selfplay-worker-merged.js");
  const n = Number(argv[2]) || 20;
  const stats = { games: 0, crashes: 0, white: 0, black: 0, draw: 0, unfinished: 0, plies: 0, modes: {}, rules: {}, crashMsgs: [] };
  for (let i = 0; i < n; i++) {
    const seed = 424242 + i * 101;
    try {
      const r = playOneGame({ searchDepth: 1, searchTimeMs: 5, maxPlies: 30, seed, flexibleBudget: true });
      stats.games++; stats.plies += r.plies; stats[r.outcome] = (stats[r.outcome] || 0) + 1;
      const sd = r.siteDraft; stats.modes[sd.mode] = (stats.modes[sd.mode] || 0) + 1;
      if (sd.ruleId) stats.rules[sd.ruleId] = (stats.rules[sd.ruleId] || 0) + 1;
    } catch (e) { stats.crashes++; stats.crashMsgs.push("seed " + seed + ": " + String(e && e.stack || e).split("\n").slice(0, 3).join(" | ")); }
  }
  const finished = stats.white + stats.black + stats.draw;
  console.log(`[${childMode}] games ${stats.games} crashes ${stats.crashes} finished(win) ${stats.white + stats.black} draw ${stats.draw} unfinished ${stats.unfinished} avgPlies ${(stats.plies / Math.max(1, stats.games)).toFixed(1)} modes ${JSON.stringify(stats.modes)} rules ${JSON.stringify(stats.rules)}`);
  for (const m of stats.crashMsgs) console.log("  CRASH " + m);
  if (stats.crashes) process.exitCode = 1;
}
