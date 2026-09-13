// Replaces the site's own AI opponent with a hybrid of Stockfish (standard-
// piece lines) and our own engine (optionally NNUE-backed -- special-piece/
// card/ability lines, which Stockfish has no concept of at all) when the
// user turns the toggle on (see content.js's ensureAiOverrideToggle -- the
// checkbox below the "AI와 플레이" card). Mirrors analysis.js's review-side
// classifyPlyMixedLines split (2026-09-09, after an all-own-engine version
// lost a game via a plain king-capture -- exactly the kind of standard-
// piece tactic Stockfish is strong at and our own engine isn't yet).
//
// The site computes AI moves in a persistent Worker
// (assets/aiWorker.js, created once and reused for the rest of the page's
// life -- confirmed live 2026-09-09). Its protocol, read directly out of
// that worker's own source (fetched and grepped for addEventListener/
// postMessage, since there's no other way to know it):
//   request:  { type: "search", state, rootActions, color, depth, timeLimitMs, id }
//   response: { type: "result", id, action, score, nodes, cutoffs }
//   (also a separate, untouched "beta-parity" message type this file
//   ignores and passes through unchanged -- not worth risking breakage on
//   a protocol path this hasn't investigated)
//
// This MUST run before the site's own bundle creates that worker -- it's a
// persistent one made once, so patching Worker even a moment too late (as
// confirmed live testing this same session found the hard way, trying to
// patch from devtools mid-session) misses it forever for that page load.
// That's why this is its own manifest content_scripts entry at
// "document_start", separate from the rest (which need document_idle,
// since they read/wait on page content that doesn't exist yet at
// document_start) -- AugmentEngine/__augNNUE from those other files won't
// exist yet when THIS file first runs, but that's fine: they're only
// looked up lazily, inside the message handler, by which point the page
// (and those other content scripts) have long since finished loading.
(function () {
  "use strict";

  const TOGGLE_KEY = "augEngineReplaceAI";
  function isEnabled() {
    try {
      return localStorage.getItem(TOGGLE_KEY) === "1";
    } catch (err) {
      return false; // localStorage can throw in some contexts (e.g. private mode edge cases) -- fail closed, use the site's own AI
    }
  }

  // Live-play Stockfish tuning (2026-09-13): player-adjustable via
  // content.js's settings block next to the AI-replace toggle. Read fresh on
  // every move (not cached) so a mid-game change takes effect immediately.
  // Same keys/clamp ranges/defaults as content.js's getStoredLiveDepth/
  // getStoredLiveThinkTimeMs -- duplicated rather than shared since this file
  // and content.js are separate content-script closures with no shared module.
  function getLiveStockfishDepth() {
    const raw = Number(localStorage.getItem("augEngineLiveStockfishDepth"));
    return raw >= 4 && raw <= 24 ? raw : 16;
  }
  function getLiveStockfishThinkTimeMs() {
    const raw = Number(localStorage.getItem("augEngineLiveStockfishThinkTimeMs"));
    return raw > 0 && raw <= 30000 ? raw : 0; // 0 = no cap, depth alone decides
  }

  const AI_WORKER_URL_PATTERN = /aiWorker\.js/;
  const OriginalWorker = window.Worker;

  // A board-editor-started game skips the site's own multi-step pre-game
  // setup screen entirely (confirmed live 2026-09-12), so its first AI move
  // request can arrive right after the page mounts -- before this file's own
  // sibling content_scripts entry (engine.js/nnue.js/stockfishClient.js/
  // hybrid.js/analysis.js/content.js, all "document_idle") has necessarily
  // finished running. That race isn't hypothetical: two live test games in a
  // plain-piece board-editor match showed the AI making moves no depth-16
  // engine would (a rook shuffled Rh1-g1 then Ra1-b1 for no reason; a knight
  // played Nf6 then immediately retreated Ng8) -- exactly what falling back
  // to this file's weak all-own-engine branch (or, worse, the site's own
  // default bot via the `!engine` branch below) looks like. A normal
  // "싱글플레이 -> AI 대국" flow has enough setup-screen delay that this
  // never showed up before. Poll briefly for `getter()` to become truthy
  // rather than giving up on the very first check -- cheap when everything
  // is already loaded (resolves on the first check, ~0ms cost), and gives
  // slow document_idle scripts a real window to finish on a fast-starting
  // game. Bounded well under the site's own failsafeMs margin (see the
  // flexibleBudget comment below: ~2x timeLimitMs, default 3500ms) so this
  // can't itself cause the "answer arrives too late, gets discarded" problem
  // it's trying to avoid.
  function waitFor(getter, timeoutMs = 500, intervalMs = 25) {
    return new Promise((resolve) => {
      const started = Date.now();
      (function poll() {
        const value = getter();
        if (value) return resolve(value);
        if (Date.now() - started >= timeoutMs) return resolve(null);
        setTimeout(poll, intervalMs);
      })();
    });
  }

  window.Worker = new Proxy(OriginalWorker, {
    construct(target, args) {
      const worker = new target(...args);
      if (!AI_WORKER_URL_PATTERN.test(String(args[0]))) return worker;

      const originalPostMessage = worker.postMessage.bind(worker);
      worker.postMessage = function (data, ...rest) {
        if (!data || data.type !== "search" || !isEnabled()) {
          return originalPostMessage(data, ...rest);
        }
        // Dispatched as a message event on the NEXT microtask/task (not
        // inside this same synchronous call) so callers that do
        // `worker.postMessage(x); /* then set up their listener */` on the
        // very next line still see it -- matches how a real worker's
        // response always arrives asynchronously too. async because the
        // Stockfish half below is a real network-free-but-still-async
        // worker round trip (queryStockfish), not a synchronous call.
        setTimeout(async () => {
          let responseData;
          try {
            const engine = window.AugmentEngine || (await waitFor(() => window.AugmentEngine));
            if (!engine) {
              // Still not loaded after the grace period -- fail safe to the
              // site's own AI rather than throw.
              return originalPostMessage(data, ...rest);
            }
            const state = engine.cloneState(data.state || {});
            engine.setWorkerBoardDimensions(state);
            const color = data.color || "black";
            const rootActions = data.rootActions || [];
            const depth = data.depth || 4;
            const nnue = window.__augNNUE;
            // flexibleBudget considered and REJECTED here (2026-09-10) --
            // unlike self-play/review, live bot play has a real external
            // deadline this file doesn't control: the site's own aiWorker
            // caller sets a hard `failsafeMs` timeout (confirmed live by
            // reading the site's own bundle: defaults are
            // AI_DEFAULT_SEARCH_TIME_MS=3500, AI_DEFAULT_FAILSAFE_MS=7000,
            // so failsafeMs is only ~2x the timeLimitMs we're handed) and
            // DISPOSES the worker + falls back to its own clock-safe move
            // if we don't respond in time -- our answer gets silently
            // thrown away. flexibleBudget multiplies the internal deadline
            // by 8x (FLEXIBLE_BUDGET_MULTIPLIER in engine.js), which would
            // massively overrun that ~2x failsafe margin on anything that
            // doesn't already finish within the original budget -- exactly
            // backwards from the self-play case this option was designed
            // for, where there's no such kill switch. Leaving this off
            // until there's a principled way to keep the effective
            // deadline under the site's real margin, not just this file's
            // guess at one.
            const searchOptions = nnue ? { evalFn: nnue.evaluateForSearch } : {};

            // Same hybrid split the review feature uses (analysis.js's
            // classifyPlyMixedLines): standard-piece lines to Stockfish
            // (genuinely strong, depth 16), special-piece/card/ability
            // lines to our own engine, since Stockfish has zero concept of
            // this game's special pieces or cards -- those can ONLY ever
            // be decided by our own engine, with or without NNUE. User
            // request 2026-09-09: previously this sent the WHOLE board
            // through our own engine even for plain standard-piece moves,
            // which are exactly what Stockfish is best at and our engine
            // is weakest at (the king-capture loss that prompted this).
            const hybrid = window.__augHybrid || (await waitFor(() => window.__augHybrid));
            const stockfish = window.__augStockfish || (await waitFor(() => window.__augStockfish));
            let sfSuggestion = null; // { action, rawScore } -- Stockfish's own centipawn score, kept only for logging
            let ourBest = null;
            let standardActions = null;
            let specialActions = null;
            if (hybrid && stockfish) {
              const attackSquares = hybrid.buildSpecialAttackSquares(engine, state, color, rootActions);
              standardActions = [];
              specialActions = [];
              for (const action of rootActions) {
                if (action.type !== "move") {
                  specialActions.push(action); // promotions/abilities: only special pieces produce these
                  continue;
                }
                if (hybrid.isSpecialInvolved(state, action.from, action.move, attackSquares)) specialActions.push(action);
                else standardActions.push(action);
              }
              if (standardActions.length) {
                const fen = hybrid.boardToFenStripSpecials(state.board, color, state.castlingCanceled);
                const uciList = standardActions
                  .map((a) => hybrid.squareToAlgebraic(a.from.row, a.from.col) + hybrid.squareToAlgebraic(a.move.row, a.move.col))
                  .join(" ");
                const result = await stockfish.queryStockfish(fen, getLiveStockfishDepth(), uciList, getLiveStockfishThinkTimeMs());
                if (result && result.score !== null && result.move) {
                  const sq1 = hybrid.algebraicToSquare(result.move.slice(0, 2));
                  const sq2 = hybrid.algebraicToSquare(result.move.slice(2, 4));
                  const action = standardActions.find((a) => a.from.row === sq1.row && a.from.col === sq1.col && a.move.row === sq2.row && a.move.col === sq2.col);
                  if (action) sfSuggestion = { action, rawScore: result.score };
                }
              }
              // Unified scoring (2026-09-13, replaces the old "compare raw
              // Stockfish centipawns against our own engine's score, larger
              // wins" logic): those two scores were NEVER guaranteed to be on
              // the same scale (Stockfish's centipawns vs. evaluateState()'s
              // hand-picked constants), which a live game caught red-handed
              // -- the AI kept spending free card actions instead of
              // responding to a rook eating its way down the back rank,
              // because our own engine's inflated card-action score kept
              // beating Stockfish's real centipawn score in that raw
              // comparison. Fix: Stockfish now only PROPOSES a candidate
              // standard move; that candidate gets folded into the SAME
              // root-candidate list our own engine already searches for
              // card/special actions, so the final pick always comes from
              // one evaluation function/scale, with our engine's existing
              // root safety filters applying to it too (they previously only
              // ever saw special/card actions here).
              //
              // NOTE (2026-09-13, corrected same day): gating this on
              // "specialActions.length" doesn't actually narrow anything --
              // a player has cards in hand from move 1 onward, so
              // specialActions is essentially always non-empty in a real
              // game. The real fix for the opening-book hazard below is
              // skipOpeningBook, not this condition.
              const ourCandidates = specialActions.slice();
              if (sfSuggestion) ourCandidates.push(sfSuggestion.action);
              if (ourCandidates.length) {
                // skipOpeningBook: true whenever a Stockfish suggestion is in
                // the mix -- searchBestAction has its own
                // pickOpeningFirstMoveAction step (fires once, on
                // turnsTaken===0 only) that can substitute a canned "looks
                // like a reasonable opening move" pick for ANY candidate
                // list it's handed, built for when our own weak engine had
                // to invent an opening move from scratch with no Stockfish
                // involved at all. Once Stockfish's real analysis of the
                // actual position is available, it should never get
                // silently swapped out for that heuristic.
                const ownOptions = sfSuggestion ? Object.assign({ skipOpeningBook: true }, searchOptions) : searchOptions;
                ourBest = engine.searchBestAction(state, ourCandidates, color, depth, data.timeLimitMs, ownOptions);
              }
            } else {
              // Stockfish/hybrid not ready yet (shouldn't really happen by
              // the time a real game move is requested, but fail back to
              // the pre-hybrid all-own-engine behavior rather than error).
              ourBest = engine.searchBestAction(state, rootActions, color, depth, data.timeLimitMs, searchOptions);
            }

            const best = ourBest;
            if (!best) throw new Error("no candidate action from either engine");
            function describeAction(action) {
              if (!action) return null;
              if (action.type === "move" && action.from && action.move) {
                return hybrid
                  ? hybrid.squareToAlgebraic(action.from.row, action.from.col) + hybrid.squareToAlgebraic(action.move.row, action.move.col)
                  : `${action.from.row},${action.from.col}->${action.move.row},${action.move.col}`;
              }
              return action.type || "?";
            }
            console.log("[증강체스엔진][ai-override] decision:", {
              hybridReady: Boolean(hybrid), stockfishReady: Boolean(stockfish),
              standardCount: standardActions?.length, specialCount: specialActions?.length,
              sfSuggestion: sfSuggestion ? { move: describeAction(sfSuggestion.action), rawScore: sfSuggestion.rawScore } : null,
              chosenMove: describeAction(best.action),
              chosenScore: best.score,
              wasSfSuggestion: sfSuggestion ? best.action === sfSuggestion.action : false
            });
            responseData = {
              type: "result",
              id: data.id,
              action: best.action,
              score: best.score,
              nodes: best?.nodes || 0,
              cutoffs: best?.cutoffs || 0
            };
          } catch (error) {
            responseData = { type: "result", id: data.id, action: null, error: String(error?.message || error) };
          }
          console.log("[증강체스엔진][ai-override] dispatching response:", responseData);
          worker.dispatchEvent(new MessageEvent("message", { data: responseData }));
        }, 0);
      };
      return worker;
    }
  });
})();
