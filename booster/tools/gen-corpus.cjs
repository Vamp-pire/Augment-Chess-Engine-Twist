// Builds a corpus of real-rule positions for speed-patch parity checks:
// random drafts and random legal actions (moves and cards) with the game's
// own rules; every few plies the search snapshot is saved (one JSON per line).
//
//   node tools/gen-corpus.cjs <worker.js> --out corpus.jsonl [--games 10] [--every 3] [--seed 1] [--mode normal]
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadGame } = require(path.join(__dirname, "harness.cjs"));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const workerPath = args[0], out = opt("out", "corpus.jsonl");
const games = Number(opt("games", 10)), every = Number(opt("every", 3)), seed = Number(opt("seed", 1)), mode = opt("mode", "normal");

function rng(s) { s >>>= 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

(async () => {
  const { game } = loadGame(workerPath);
  const rand = rng(seed);
  let saved = 0;
  for (let gi = 0; gi < games; gi++) {
    const configuration = await game.createGameConfiguration({ mode });
    const session = await game.CanonicalEditorSession.create({
      gameId: crypto.randomUUID(), configuration,
      seed: crypto.createHash("sha256").update(`corpus-${seed}-${gi}`).digest("base64url"),
      localOptions: { deathmatchEnabled: true }
    });
    session.disableLocalFirstMoveLimit?.();
    let ply = 0;
    for (let step = 0; step < 400; step++) {
      const g = session.snapshot({ includeHistory: false }).game;
      if (g.status === "FINISHED" || g.moveCount > 150) break;
      if (g.status === "DRAFTING") {
        const actor = g.cardState.draft.pickingColor ?? g.position.turn;
        const q = session.draftChoices(actor);
        if (!q.ok) break;
        const c = q.choices[Math.floor(rand() * q.choices.length)];
        if (!(await session.dispatch(actor, { schemaVersion: 1, kind: "draft_pick", payload: { offerId: q.offerId, choiceId: c.choiceId } })).ok) break;
        continue;
      }
      if (session.localAiAutomaticCardsDue?.()) { if (!(await session.advanceLocalAiAutomaticCards())?.ok) break; continue; }
      const snap = session.searchSnapshot();
      if (ply++ % every === 0) { fs.appendFileSync(out, JSON.stringify(snap) + "\n"); saved++; }
      const q = await game.canonicalAiActionCandidates(session, { includeCards: true, maxCardProbes: 24, canContinue: () => true, moveCanContinue: () => true });
      if (!q.actions.length) break;
      // cards a third of the time when available, else a move (captures favoured)
      const cards = q.actions.filter((a) => a.intent.kind !== "piece_move"), moves = q.actions.filter((a) => a.intent.kind === "piece_move");
      let pool = cards.length && rand() < 0.33 ? cards : moves.length ? moves : cards;
      const a = pool[Math.floor(rand() * pool.length)];
      const r = await game.applyCanonicalAiCandidate(session, a);
      if (!r?.ok) break;
    }
    console.log(`game ${gi}: ${ply} plies, saved ${saved}`);
  }
})();
