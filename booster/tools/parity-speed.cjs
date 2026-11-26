// Speed-patch parity: the original and the speed-patched worker must give
// the same legal actions (moves and cards) and, for each action, the same
// resulting game state, on every corpus position. Also reports timings.
//
//   node tools/parity-speed.cjs <worker.js> <corpus.jsonl>... [--apply 8] [--limit 0]
// --apply N: apply up to N actions per position (cards first) and compare states.
"use strict";
const fs = require("fs");
const path = require("path");
const { loadGame } = require(path.join(__dirname, "harness.cjs"));
const { applySpeedPatches } = require(path.join(__dirname, "..", "speed-patches.js"));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? Number(args[i + 1]) : d; };
const files = args.slice(1).filter((x, i, a) => !x.startsWith("--") && !(a[i - 1] ?? "").startsWith("--"));
const applyN = opt("apply", 8), limit = opt("limit", 0);
if (args.includes("--shadow")) globalThis.__acbSpeedShadow = {};

const src = fs.readFileSync(args[0], "utf8");
const sp = process.argv.includes("--control") ? { code: src, applied: ["(control: original on both sides)"], skipped: [] } : applySpeedPatches(src);
console.log(`speed patches applied: ${sp.applied.join(", ") || "none"}${sp.skipped.length ? `; skipped: ${sp.skipped.join(", ")}` : ""}`);
const A = loadGame(args[0]).game, B = loadGame(args[0], { patchedCode: sp.code }).game;

const stateKey = (s) => JSON.stringify(s.snapshot({ includeHistory: false }).game);

// AI copies of a game get a fresh random seed (crypto.getRandomValues), so
// both sides are given the same random sequence before each copy is made.
const nativeRandom = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
let rs = 1;
globalThis.crypto.getRandomValues = (arr) => {
  const b = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  for (let i = 0; i < b.length; i++) { rs = (rs * 1664525 + 1013904223) >>> 0; b[i] = rs >>> 24; }
  return arr;
};
const reseed = (k) => { rs = k >>> 0 || 1; };
void nativeRandom;

async function listing(game, snap) {
  const t = performance.now();
  const session = await game.CanonicalEditorSession.restoreForAi(snap);
  const q = await game.canonicalAiActionCandidates(session, { includeCards: true, maxCardProbes: 24, canContinue: () => true, moveCanContinue: () => true });
  return { session, q, ms: performance.now() - t };
}

(async () => {
  let n = 0, bad = 0, msA = 0, msB = 0, applied = 0;
  for (const f of files) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      if (limit && n >= limit) break;
      n++;
      const raw = JSON.parse(line);
      let errA = null, errB = null, a = null, b = null;
      try { a = await listing(A, await A.prepareCanonicalAiSearchSnapshot(structuredClone(raw))); } catch (e) { errA = String(e?.message || e); }
      try { b = await listing(B, await B.prepareCanonicalAiSearchSnapshot(structuredClone(raw))); } catch (e) { errB = String(e?.message || e); }
      if (errA || errB) {
        if (errA !== errB) { bad++; console.log(`#${n} error mismatch: original=${errA} patched=${errB}`); }
        continue;
      }
      msA += a.ms; msB += b.ms;
      const ka = a.q.actions.map((x) => JSON.stringify(x.intent)), kb = b.q.actions.map((x) => JSON.stringify(x.intent));
      if (JSON.stringify(ka) !== JSON.stringify(kb)) {
        bad++;
        console.log(`#${n} action lists differ (${ka.length} vs ${kb.length})`);
        continue;
      }
      // apply a few actions (cards first) on fresh sessions and compare states
      const order = a.q.actions.map((x, i) => i).sort((i, j) => (a.q.actions[j].intent.kind !== "piece_move") - (a.q.actions[i].intent.kind !== "piece_move"));
      for (const i of order.slice(0, applyN)) {
        reseed(n * 1000 + i);
        const sa = await A.CanonicalEditorSession.restoreForAi(await A.prepareCanonicalAiSearchSnapshot(structuredClone(raw)));
        let ra, rb;
        try { ra = await A.applyCanonicalAiCandidate(sa, a.q.actions[i]); } catch (e) { ra = { ok: false, code: String(e?.message || e) }; }
        reseed(n * 1000 + i);
        const sb = await B.CanonicalEditorSession.restoreForAi(await B.prepareCanonicalAiSearchSnapshot(structuredClone(raw)));
        try { rb = await B.applyCanonicalAiCandidate(sb, b.q.actions[i]); } catch (e) { rb = { ok: false, code: String(e?.message || e) }; }
        applied++;
        if (Boolean(ra?.ok) !== Boolean(rb?.ok) || (ra?.ok && stateKey(sa) !== stateKey(sb))) {
          bad++;
          console.log(`#${n} action ${ka[i].slice(0, 100)}: results differ (ok ${ra?.ok}/${rb?.ok})`);
        }
      }
    }
  }
  if (globalThis.__acbSpeedShadow) console.log("shadow checks", JSON.stringify(globalThis.__acbSpeedShadow));
  console.log(`positions ${n}, applied actions ${applied}, mismatches ${bad}, listing ms original ${Math.round(msA)} patched ${Math.round(msB)} (x${(msA / Math.max(1, msB)).toFixed(2)})`);
  process.exitCode = bad ? 1 : 0;
})();
