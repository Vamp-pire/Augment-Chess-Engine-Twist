(function () {
  "use strict";

  const TYPE_LABELS = {
    king: "킹", queen: "퀸", rook: "룩", bishop: "비숍", knight: "나이트", pawn: "폰",
    colossus: "거신병", protestant: "프로테스탄트", herald: "전령", cannon: "포",
    fanatic: "광신도", primeMinister: "국무총리", eagle: "알리바바", amazon: "아마존",
    cardinal: "추기경", pegasus: "유니콘", jester: "광대", camel: "낙타", log: "통나무",
    merchant: "상인", hook: "구행", grasshopper: "그래스호퍼", royalKnight: "로얄 나이트",
    man: "만", assassin: "암살자", guard: "근위병", reaper: "사신", wizard: "마법사",
    dragon: "드래곤", shotgunKing: "샷건 킹", scarecrow: "허수아비", alfil: "알필",
    windmill: "풍차", knightmaster: "기사단장", standardBearer: "기수", recruiter: "징집관",
    squire: "종자", checker: "체커", checkerKing: "킹 체커", bigRook: "빅룩", idol: "아이돌",
    lobster: "랍스터", babyBear: "아기곰", bear: "곰", vip: "귀빈", crown: "왕관",
    missionary: "선교사", siegeRam: "공성추", magicGirl: "마법소녀", berserker: "버서커",
    slime: "슬라임", siren: "세이렌", trickster: "트릭스터", undead: "언데드",
    football: "축구공", monster: "괴물", blackHole: "블랙홀", darkWizard: "흑마법사",
    ferz: "페르즈", timeTraveler: "시간 여행자", vampireLord: "뱀파이어 군주",
    bat: "박쥐", coffin: "오래된 관"
  };

  const KOREAN_TO_TYPE = {};
  Object.keys(TYPE_LABELS).forEach((type) => {
    const label = TYPE_LABELS[type];
    if (!KOREAN_TO_TYPE[label]) KOREAN_TO_TYPE[label] = type;
  });

  const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

  function squareToRowCol(square) {
    const file = square[0];
    const rank = Number(square.slice(1));
    const col = FILES.indexOf(file);
    const row = 8 - rank;
    return { row, col };
  }

  function rowColToSquare(row, col) {
    return FILES[col] + (8 - row);
  }

  function readBoardFromDOM() {
    const squares = document.querySelectorAll("button.square");
    if (!squares.length) return null;
    const board = Array.from({ length: 8 }, () => Array(8).fill(null));
    let ok = true;
    squares.forEach((el) => {
      const label = el.getAttribute("aria-label") || "";
      const parts = label.trim().split(/\s+/);
      if (parts.length < 2) { ok = false; return; }
      const square = parts[0];
      const { row, col } = squareToRowCol(square);
      if (!(row >= 0 && row < 8 && col >= 0 && col < 8)) { ok = false; return; }
      if (parts[1] === "빈") { board[row][col] = null; return; }
      const color = parts[1] === "백" ? "white" : parts[1] === "흑" ? "black" : null;
      const koreanName = parts.slice(2).join(" ");
      const type = KOREAN_TO_TYPE[koreanName];
      if (!color || !type) { ok = false; return; }
      board[row][col] = { type, color, moved: false };
    });
    return ok ? board : null;
  }

  function readTurnFromDOM() {
    const el = Array.from(document.querySelectorAll("span,button,div")).find(
      (e) => e.children.length === 0 && /^(백|흑) 차례$/.test(e.textContent.trim())
    );
    if (!el) return null;
    return el.textContent.trim().startsWith("백") ? "white" : "black";
  }

  function boardsEqual(a, b) {
    if (!a || !b) return false;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const pa = a[r][c];
        const pb = b[r][c];
        if (!pa && !pb) continue;
        if (!pa || !pb) return false;
        if (pa.type !== pb.type || pa.color !== pb.color) return false;
      }
    }
    return true;
  }

  function diffLastMove(before, after, moverColor) {
    if (!before || !after) return null;
    let vacated = null;
    let landed = null;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const pb = before[r][c];
        const pa = after[r][c];
        if (pb && pb.color === moverColor && (!pa || pa.color !== moverColor)) {
          if (!vacated) vacated = { row: r, col: c };
        }
        if ((!pb || pb.color !== moverColor) && pa && pa.color === moverColor) {
          landed = { row: r, col: c };
        }
      }
    }
    if (!vacated || !landed) return null;
    return { from: vacated, to: landed };
  }

  function makeEngineState(engine, board, turn) {
    const state = engine.cloneState({});
    state.board = board;
    state.mode = "play";
    state.turn = turn;
    state.actionsRemaining = 1;
    state.deckSlots = { white: [], black: [] };
    state.captures = { white: [], black: [] };
    state.aiSearchNoCards = true;
    state.turnsTaken = { white: 5, black: 5 };
    return state;
  }

  function actionMatchesSquares(action, from, to) {
    if (!action || action.type !== "move") return false;
    const dest = action.move || {};
    return (
      action.from?.row === from.row && action.from?.col === from.col &&
      dest.row === to.row && dest.col === to.col
    );
  }

  const CLASSIFICATIONS = [
    { id: "best", icon: "move_best.svg", label: "최선" },
    { id: "excellent", icon: "move_excellent.svg", label: "훌륭함" },
    { id: "good", icon: "move_good.svg", label: "좋음" },
    { id: "inaccuracy", icon: "move_inaccuracy.svg", label: "부정확" },
    { id: "mistake", icon: "move_mistake.svg", label: "실수" },
    { id: "blunder", icon: "move_blunder.svg", label: "블런더" },
    { id: "forced", icon: "move_forced.svg", label: "유일한 수" }
  ];

  // NOTE: this engine's eval scale is noisier than centipawns (positional/king-safety
  // terms alone can swing 200-300+ at shallow search depth even for two perfectly
  // reasonable moves), so thresholds are calibrated wider than chess.com's.
  function classify(loss, isForced, isTopChoice) {
    if (isForced) return CLASSIFICATIONS.find((c) => c.id === "forced");
    if (isTopChoice || loss <= 15) return CLASSIFICATIONS.find((c) => c.id === "best");
    if (loss <= 150) return CLASSIFICATIONS.find((c) => c.id === "excellent");
    if (loss <= 350) return CLASSIFICATIONS.find((c) => c.id === "good");
    if (loss <= 700) return CLASSIFICATIONS.find((c) => c.id === "inaccuracy");
    if (loss <= 1500) return CLASSIFICATIONS.find((c) => c.id === "mistake");
    return CLASSIFICATIONS.find((c) => c.id === "blunder");
  }

  // Stockfish's loss is real centipawns, not our engine's noisier internal
  // scale -- reusing the wide thresholds above would call a 2-pawn blunder
  // "good". These are close to chess.com's own conventions.
  function classifyStockfish(loss, isForced, isTopChoice) {
    if (isForced) return CLASSIFICATIONS.find((c) => c.id === "forced");
    if (isTopChoice || loss <= 10) return CLASSIFICATIONS.find((c) => c.id === "best");
    if (loss <= 25) return CLASSIFICATIONS.find((c) => c.id === "excellent");
    if (loss <= 50) return CLASSIFICATIONS.find((c) => c.id === "good");
    if (loss <= 100) return CLASSIFICATIONS.find((c) => c.id === "inaccuracy");
    if (loss <= 200) return CLASSIFICATIONS.find((c) => c.id === "mistake");
    return CLASSIFICATIONS.find((c) => c.id === "blunder");
  }

  function describeAction(action) {
    if (!action || action.type !== "move") return "-";
    const from = rowColToSquare(action.from.row, action.from.col);
    const to = rowColToSquare(action.move.row, action.move.col);
    return from + " → " + to;
  }

  // ---- Post-game-only full review ----
  // Entry to this whole module is gated by isGameOver() in content.js: recommending
  // moves while a game is still in progress would be usable as live cheating aid,
  // so this only ever looks backward at a finished game's move history.

  // This only ever runs after the game has ended (see isGameOver gate below),
  // so nobody is sitting there waiting on a clock the way they would mid-game.
  // Two budgets: "deep" is the original generous one for whoever explicitly
  // asks for a precise re-check; "fast" is the default for the initial full-
  // game pass, since dozens of plies at the deep budget is what made a full
  // review take minutes. Both still use the adaptive quick-probe-first
  // strategy below, just scaled down together.
  const SEARCH_BUDGETS = {
    deep: { fullDepth: 8, fullTimeMs: 8000, quickDepth: 5, quickTimeMs: 1500 },
    fast: { fullDepth: 6, fullTimeMs: 2500, quickDepth: 4, quickTimeMs: 800 }
  };
  let reviewSpeedMode = "fast"; // set per review run by runFullGameReview's `mode` argument

  function currentSearchBudget() {
    return SEARCH_BUDGETS[reviewSpeedMode] || SEARCH_BUDGETS.fast;
  }

  // A quiet position (no captures on the board, nothing forced) rarely needs
  // the full budget to get right, and a full-game review can be dozens of
  // these back to back -- so probe shallow/short first, and only pay for the
  // full search when the quick probe itself says this position is worth it
  // (either a close call between the top two candidates, or a capture/
  // ability action sitting right there making it tactically loud).
  const AMBIGUOUS_SCORE_GAP = 80;

  // ---- Parallel root search ----
  // Splits the root candidate actions into small chunks and hands them out to
  // a pool of Web Workers (each running the exact same engine.js), taking the
  // best result across all of them. Alpha-beta over a subset of root moves is
  // still valid -- it's the same algorithm, just without pruning benefits
  // *across* subsets -- so this is a free-ish speedup rather than an
  // algorithmic change.
  //
  // The pool is an idle-worker task queue (same design as stockfishClient.js's
  // pool): chunks from possibly many concurrent calls (different plies being
  // reviewed at once, see reviewPositions) all land in one shared queue, and
  // whichever worker frees up next just grabs the next chunk waiting -- no
  // chunk is tied to a specific worker index. That's what makes resizing the
  // pool safe at any time: shrinking only ever terminates a currently-idle
  // worker, never one mid-search, so it can't strand another call's
  // already-dispatched chunk the way the old fixed-assignment version could.
  const MAX_SEARCH_WORKERS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  let searchWorkerCount = MAX_SEARCH_WORKERS;
  let searchWorkers = [];
  let searchQueue = [];
  let nextRequestId = 1;

  function ensureSearchPoolSize() {
    try {
      while (searchWorkers.length < searchWorkerCount) {
        // chrome.runtime unavailable in this file's MAIN-world context -- see
        // ext-bridge.js/content.js's comments on the isolated/main world fix.
        searchWorkers.push({ worker: new Worker((document.documentElement.dataset.augExtBase || "") + "searchWorker.js"), busy: false });
      }
    } catch (err) {
      // leave whatever we managed to spawn; callers fall back to the
      // synchronous single-thread path if the pool ends up empty
    }
    while (searchWorkers.length > searchWorkerCount) {
      const idleIndex = searchWorkers.findIndex((w) => !w.busy);
      if (idleIndex === -1) break;
      searchWorkers[idleIndex].worker.terminate();
      searchWorkers.splice(idleIndex, 1);
    }
  }

  function setSearchWorkerCount(n) {
    searchWorkerCount = Math.max(1, Math.min(4, Math.round(Number(n)) || MAX_SEARCH_WORKERS));
    ensureSearchPoolSize();
    pumpSearchQueue();
    return searchWorkerCount;
  }

  function runSearchTask(entry, task) {
    entry.busy = true;
    const requestId = nextRequestId++;
    const worker = entry.worker;
    function messageHandler(event) {
      if (event.data?.requestId !== requestId) return;
      cleanup();
      task.resolve(event.data);
    }
    function errorHandler(err) {
      cleanup();
      task.resolve({ ok: false, error: String(err?.message || err) }); // let the caller's existing "not ok" handling take over instead of hanging forever
    }
    function cleanup() {
      worker.removeEventListener("message", messageHandler);
      worker.removeEventListener("error", errorHandler);
      entry.busy = false;
      pumpSearchQueue();
    }
    worker.addEventListener("message", messageHandler);
    worker.addEventListener("error", errorHandler);
    worker.postMessage(Object.assign({ requestId }, task.payload));
  }

  function pumpSearchQueue() {
    ensureSearchPoolSize();
    for (const entry of searchWorkers) {
      if (entry.busy) continue;
      const task = searchQueue.shift();
      if (!task) break;
      runSearchTask(entry, task);
    }
  }

  // Review's own NNUE toggle (2026-09-09, content.js's checkbox next to the
  // review buttons) -- separate from ai-override.js's toggle for live bot
  // play, since a user might want one on and not the other (e.g. trust
  // NNUE enough to try it on a past game's review but not to actually play
  // moves with). Threaded through to searchWorker.js as a plain field on
  // the request payload; nnue.js's evaluateForSearch() (used as the
  // resulting evalFn) already falls back to evaluateState() on its own
  // when weights aren't loaded or a position is terminal.
  let useNnueForReview = false;
  function setUseNnueForReview(v) { useNnueForReview = Boolean(v); }
  function getUseNnueForReview() { return useNnueForReview; }

  function askWorkerPool(payload) {
    return new Promise((resolve) => {
      searchQueue.push({ payload, resolve });
      pumpSearchQueue();
    });
  }


  // Own-engine search limits (2026-09-19), player-adjustable in content.js's
  // "세부 설정" block. Read fresh on every search. The same keys/clamps are read
  // in analysis.js and ai-override.js (separate content-script closures, no
  // shared module). Returns options.limits for engine.searchBestAction:
  // time is the soft budget, depth is unlimited (12) unless set, and the
  // engine may extend past the soft time when a depth is almost finished.
  function readOwnEngineLimits(defaultTimeMs, hardCapMs) {
    const num = (key) => { try { return Number(localStorage.getItem(key)); } catch (e) { return 0; } };
    let extend = true;
    try { extend = localStorage.getItem("augEngineOwnExtend") !== "0"; } catch (e) { /* default on */ }
    const maxDepth = num("augEngineOwnMaxDepth");
    const think = num("augEngineOwnThinkTimeMs");
    const minDepth = num("augEngineOwnMinDepth");
    const soft = think > 0 ? Math.min(think, 60000) : defaultTimeMs;
    const limits = {
      depth: maxDepth >= 1 ? Math.min(12, Math.floor(maxDepth)) : 12,
      movetimeMs: soft,
      minDepth: minDepth >= 1 ? Math.min(8, Math.floor(minDepth)) : 0,
      extend,
      extendFactor: 2
    };
    if (hardCapMs) limits.hardTimeMs = Math.max(soft, hardCapMs);
    return limits;
  }

  async function parallelSearchBestAction(engine, state, actions, color, depth, timeMs, limits) {
    const nnueOptions = useNnueForReview && self.__augNNUE ? { evalFn: self.__augNNUE.evaluateForSearch } : {};
    if (limits) nnueOptions.limits = limits;
    const fallback = () => engine.searchBestAction(state, actions, color, depth, timeMs, nnueOptions);
    if (typeof Worker === "undefined" || actions.length < 4) return fallback();
    ensureSearchPoolSize();
    const workerCount = searchWorkers.length;
    if (!workerCount) return fallback();

    const chunks = Array.from({ length: workerCount }, () => []);
    actions.forEach((action, i) => chunks[i % workerCount].push(action));
    let responses;
    try {
      responses = await Promise.all(
        chunks.map((chunk) => (chunk.length ? askWorkerPool({ state, actionSubset: chunk, color, depth, timeMs, limits, useNnue: useNnueForReview, nnueModel: self.__augNNUE?.getModel?.() }) : Promise.resolve(null)))
      );
    } catch (err) {
      return fallback();
    }
    const results = responses.filter((r) => r && r.ok).map((r) => r.result);
    if (!results.length) return fallback();
    const best = results.reduce((a, b) => (b.score > a.score ? b : a));
    return {
      action: best.action,
      score: best.score,
      completedDepth: Math.min(...results.map((r) => r.completedDepth)),
      nodes: results.reduce((s, r) => s + (r.nodes || 0), 0),
      cutoffs: results.reduce((s, r) => s + (r.cutoffs || 0), 0),
      candidates: results.flatMap((r) => r.candidates || [])
    };
  }

  // Any candidate that isn't a plain quiet move -- a capture (destination
  // square occupied), or a non-move/promotion action (only special-ability
  // actions look like that) -- counts as a tactical signal worth paying full
  // price for.
  //
  // Only meant to be called with the top few ranked candidates from the
  // quick probe, NOT the full root action list -- was being passed every
  // legal action for the whole position (2026-09-08 fix). With a large
  // branching factor (lots of special pieces, big boards), almost any
  // position has SOME capture available somewhere among dozens of
  // candidates, even a totally irrelevant one nobody would actually play --
  // so this was returning true for nearly every position, forcing the full
  // (slow) budget on almost every ply and defeating the entire point of the
  // cheap-first design (found chasing a report of reviews taking 10+
  // minutes even in fast mode). Checking only the moves the engine actually
  // considers best keeps the original intent -- escalate when a real
  // tactical shot is on the table -- without the false-positive blowup.
  function hasTacticalSignal(state, actions) {
    return actions.some((a) => {
      if (a.type !== "move" && a.type !== "promotion") return true;
      const dest = a.move;
      return Boolean(dest && state.board[dest.row] && state.board[dest.row][dest.col]);
    });
  }

  const TACTICAL_SIGNAL_TOP_N = 3;

  // Cheap-first search: probe shallow/short, and only escalate to the full
  // budget (fast or deep, whichever reviewSpeedMode is active) when the
  // quick probe itself flags the position as worth it (top two candidates
  // close together, or a capture/ability among the top few candidates). A
  // quiet position gets a fast, "good enough" answer instead of always
  // paying full price.
  async function adaptiveSearchBestAction(engine, state, actions, color) {
    const budget = currentSearchBudget();
    const quick = await parallelSearchBestAction(engine, state, actions, color, budget.quickDepth, budget.quickTimeMs);
    const ranked = Array.isArray(quick.candidates) ? quick.candidates.slice().sort((a, b) => b.score - a.score) : [];
    const gap = ranked.length >= 2 ? ranked[0].score - ranked[1].score : Infinity;
    const topActions = ranked.slice(0, TACTICAL_SIGNAL_TOP_N).map((c) => c.action);
    if (gap < AMBIGUOUS_SCORE_GAP || hasTacticalSignal(state, topActions)) {
      return parallelSearchBestAction(engine, state, actions, color, budget.fullDepth, budget.fullTimeMs, readOwnEngineLimits(budget.fullTimeMs));
    }
    return quick;
  }

  function isGameOver() {
    const btn = document.querySelector("#newGameButton");
    if (!btn) return false;
    return /종료/.test(btn.textContent || "");
  }

  function standardStartingBoard() {
    const back = ["rook", "knight", "bishop", "queen", "king", "bishop", "knight", "rook"];
    const board = Array.from({ length: 8 }, () => Array(8).fill(null));
    for (let c = 0; c < 8; c++) {
      board[0][c] = { type: back[c], color: "black", moved: false };
      board[1][c] = { type: "pawn", color: "black", moved: false };
      board[6][c] = { type: "pawn", color: "white", moved: false };
      board[7][c] = { type: back[c], color: "white", moved: false };
    }
    return board;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Clicks through the notation panel's move entries (read-only replay navigation,
  // not real moves) and snapshots the board after each one. Card-play entries
  // (.notation-gain) are skipped as moves but their effect is still reflected in
  // the board snapshot taken right after, since the site's own replay is authoritative.
  async function collectMoveHistoryPositions() {
    const wrap = document.querySelector("#notationTableWrap");
    if (!wrap) return null;
    const moveButtons = Array.from(wrap.querySelectorAll(".notation-entry.notation-move"));
    if (!moveButtons.length) return null;
    const positions = [standardStartingBoard()];
    const cardBetween = [false];
    let sawCardSinceLastMove = false;
    for (const el of Array.from(wrap.querySelectorAll(".notation-entry"))) {
      if (el.classList.contains("notation-gain")) {
        sawCardSinceLastMove = true;
        continue;
      }
      if (!el.classList.contains("notation-move")) continue;
      el.click();
      await wait(120);
      const board = readBoardFromDOM();
      if (!board) return null;
      positions.push(board);
      cardBetween.push(sawCardSinceLastMove);
      sawCardSinceLastMove = false;
    }
    return { positions, cardBetween, plyCount: moveButtons.length };
  }

  // Splits this position's root candidate moves into "lines" and hands each
  // line to whichever engine can actually judge it: lines untouched by any
  // special piece go to Stockfish (restricted via UCI searchmoves to just
  // that subset, so one query gives the best-of-those-lines score); lines
  // that touch a special piece in any way, plus any special-ability action
  // (fileSurgeSkip/shotgunReload/wizardSpell), go to our own engine's search.
  // The overall bestEval is whichever side's top line scores higher, and the
  // played move's actualEval comes from whichever side its own line belongs
  // to. Returns null (caller falls back to the full own-engine pipeline)
  // whenever Stockfish is unavailable, or the played move's score can't be
  // pinned down cleanly.
  async function classifyPlyMixedLines(engine, beforeState, moverColor, beforeActions, diff, isForced) {
    const hybrid = window.__augHybrid;
    if (!hybrid || !window.__augStockfish || !diff) return null;

    const attackSquares = hybrid.buildSpecialAttackSquares(engine, beforeState, moverColor, beforeActions);
    const standardActions = [];
    const specialActions = [];
    for (const action of beforeActions) {
      if (action.type !== "move") {
        specialActions.push(action); // promotions/abilities: only special pieces produce these
        continue;
      }
      if (hybrid.isSpecialInvolved(beforeState, action.from, action.move, attackSquares)) {
        specialActions.push(action);
      } else {
        standardActions.push(action);
      }
    }

    let sfBest = null;
    if (standardActions.length) {
      const fen = hybrid.boardToFenStripSpecials(beforeState.board, moverColor, beforeState.castlingCanceled);
      const uciList = standardActions
        .map((a) => hybrid.squareToAlgebraic(a.from.row, a.from.col) + hybrid.squareToAlgebraic(a.move.row, a.move.col))
        .join(" ");
      const result = await window.__augStockfish.queryStockfish(fen, 16, uciList);
      if (result && result.score !== null && result.move) sfBest = result;
    }

    let ourBest = null;
    if (specialActions.length) {
      ourBest = await adaptiveSearchBestAction(engine, beforeState, specialActions, moverColor);
    }
    if (!sfBest && !ourBest) return null;

    // Both scores are mover-perspective and the same rough order of
    // magnitude (classify()/classifyStockfish()'s threshold tables already
    // lean on that -- ours is just noisier, hence looser bands), so the
    // larger one directly identifies the true best line across both engines.
    let bestEval;
    let bestMoveUci = null;
    if (sfBest && (!ourBest || sfBest.score >= ourBest.score)) {
      bestEval = sfBest.score;
      bestMoveUci = sfBest.move;
    } else {
      bestEval = ourBest.score;
      if (ourBest.action && ourBest.action.type === "move") {
        bestMoveUci = hybrid.squareToAlgebraic(ourBest.action.from.row, ourBest.action.from.col) + hybrid.squareToAlgebraic(ourBest.action.move.row, ourBest.action.move.col);
      }
    }

    const playedUci = hybrid.squareToAlgebraic(diff.from.row, diff.from.col) + hybrid.squareToAlgebraic(diff.to.row, diff.to.col);
    const playedIsSpecial = hybrid.isSpecialInvolved(beforeState, diff.from, diff.to, attackSquares);
    let actualEval = null;
    let actualSource = null;

    if (!playedIsSpecial && sfBest) {
      actualSource = "stockfish";
      if (sfBest.move === playedUci) {
        actualEval = sfBest.score;
      } else {
        const fen = hybrid.boardToFenStripSpecials(beforeState.board, moverColor, beforeState.castlingCanceled);
        const played = await window.__augStockfish.queryStockfish(fen, 16, playedUci);
        if (played && played.score !== null) actualEval = played.score;
      }
    } else if (ourBest && Array.isArray(ourBest.candidates)) {
      actualSource = "engine";
      const matched = ourBest.candidates.find((c) => actionMatchesSquares(c.action, diff.from, diff.to));
      if (matched) actualEval = matched.score;
    }

    if (actualEval === null) return null;

    const isTopChoice = bestMoveUci !== null && playedUci === bestMoveUci;
    const loss = Math.max(0, bestEval - actualEval);
    const classifier = actualSource === "stockfish" ? classifyStockfish : classify;

    return {
      moverColor,
      from: rowColToSquare(diff.from.row, diff.from.col),
      to: rowColToSquare(diff.to.row, diff.to.col),
      loss: Math.round(loss),
      classification: classifier(loss, isForced, isTopChoice),
      source: "mixed:" + actualSource
    };
  }

  async function classifyPly(engine, beforeBoard, moverColor, afterBoard) {
    const beforeState = makeEngineState(engine, beforeBoard, moverColor);
    engine.setWorkerBoardDimensions(beforeState);
    const beforeActions = engine.generateActions(beforeState, moverColor);
    if (!beforeActions.length) return null;
    const isForced = beforeActions.length === 1;
    const diff = diffLastMove(beforeBoard, afterBoard, moverColor);

    const mixedResult = await classifyPlyMixedLines(engine, beforeState, moverColor, beforeActions, diff, isForced);
    if (mixedResult) return mixedResult;

    const beforeResult = await adaptiveSearchBestAction(engine, beforeState, beforeActions, moverColor);
    const bestEval = beforeResult.score;
    const isTopChoice = diff ? actionMatchesSquares(beforeResult.action, diff.from, diff.to) : false;

    // Prefer reading the played move's score straight out of the SAME search
    // pass that produced bestEval (same depth, same context -> directly
    // comparable). Only fall back to a fresh independent search on the
    // post-move position (noisier: it can reach a different depth than the
    // pre-move search, which was making almost every move look artificially
    // "best" whenever that independent search happened to run deeper) when the
    // played move wasn't among the searched root candidates at all -- e.g. it
    // got filtered out by a hard safety check.
    let actualEval = null;
    if (diff && Array.isArray(beforeResult.candidates)) {
      const matched = beforeResult.candidates.find((c) => actionMatchesSquares(c.action, diff.from, diff.to));
      if (matched) actualEval = matched.score;
    }
    if (actualEval === null) {
      const opponentColor = moverColor === "white" ? "black" : "white";
      const afterState = makeEngineState(engine, afterBoard, opponentColor);
      engine.setWorkerBoardDimensions(afterState);
      const afterActions = engine.generateActions(afterState, opponentColor);
      if (!afterActions.length) {
        actualEval = engine.evaluateState(afterState, moverColor);
      } else {
        // Was a direct, synchronous engine.searchBestAction() call on the
        // main thread -- unlike every other search in this file, which goes
        // through parallelSearchBestAction's Web Worker pool. Since JS is
        // single-threaded, that blocked the ENTIRE page (including the
        // worker message handlers coordinating every OTHER position's
        // review) for up to fullTimeMs each time this fallback fired -- and
        // it fires whenever the played move wasn't among the searched root
        // candidates, which isn't rare. With several plies "reviewing
        // concurrently" (see reviewPositions), this one synchronous call
        // serialized all of them, defeating the whole pooled/parallel
        // design and turning what should be a sub-minute review into
        // several minutes (found 2026-09-08 chasing a report of a 34-move
        // fast review taking 10+ minutes). Routed through the same worker
        // pool as every other search here.
        const fallbackBudget = currentSearchBudget();
        const opponentBest = await parallelSearchBestAction(engine, afterState, afterActions, opponentColor, fallbackBudget.fullDepth, fallbackBudget.fullTimeMs, readOwnEngineLimits(fallbackBudget.fullTimeMs));
        actualEval = -opponentBest.score;
      }
    }

    const loss = Math.max(0, bestEval - actualEval);
    return {
      moverColor,
      from: diff ? rowColToSquare(diff.from.row, diff.from.col) : "-",
      to: diff ? rowColToSquare(diff.to.row, diff.to.col) : "-",
      loss: Math.round(loss),
      classification: classify(loss, isForced, isTopChoice),
      source: "engine"
    };
  }

  const ACCURACY_WEIGHT = { best: 100, excellent: 95, good: 85, inaccuracy: 70, mistake: 50, blunder: 20, forced: 100, skipped: 80 };

  function accuracyOf(plies, color) {
    const relevant = plies.filter((p) => p.moverColor === color);
    if (!relevant.length) return null;
    const sum = relevant.reduce((s, p) => s + (ACCURACY_WEIGHT[p.classification.id] ?? 70), 0);
    return Math.round(sum / relevant.length);
  }

  // Rough first pass at scoring a card-play turn: just the net static-eval
  // swing from right before this turn to right after it (no search -- we
  // don't have search-quality "what if a different card had been drafted"
  // information to compare against, since a finished game's record doesn't
  // keep the cards that weren't picked). This will misattribute some of the
  // swing to whatever move happened alongside the card on the same turn, and
  // reuses the move-classification thresholds/labels even though "this card
  // was a blunder" isn't really being tested here -- it's a placeholder to
  // stop cards being a total blind spot, not a real card-quality judgment.
  function classifyCardTurn(engine, beforeBoard, moverColor, afterBoard) {
    const beforeState = makeEngineState(engine, beforeBoard, moverColor);
    engine.setWorkerBoardDimensions(beforeState);
    const beforeEval = engine.evaluateState(beforeState, moverColor);
    const afterState = makeEngineState(engine, afterBoard, moverColor);
    engine.setWorkerBoardDimensions(afterState);
    const afterEval = engine.evaluateState(afterState, moverColor);
    const loss = Math.max(0, beforeEval - afterEval);
    return {
      moverColor,
      from: "-",
      to: "-",
      loss: Math.round(loss),
      classification: classify(loss, false, false),
      source: "card-delta"
    };
  }

  // How many plies to classify at once. Kept modest on purpose: the
  // Stockfish side has its own pool now (see stockfishClient.js, sized by the
  // user's instance-count setting) and the own-engine side has its own
  // worker pool too, so running more plies at once mostly helps by
  // overlapping a stockfish-only ply's wait time with another ply's
  // own-engine search -- it doesn't multiply throughput the way independent
  // CPU cores dedicated to each ply would. Defaults to the device's core
  // count so a low-end machine doesn't thrash itself running more concurrent
  // ply-reviews (each with its own worker pool pressure) than it has cores
  // to back them, but content.js lets the user override it manually.
  function autoReviewConcurrency() {
    return Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
  }
  let reviewConcurrency = autoReviewConcurrency();

  function setReviewConcurrency(n) {
    reviewConcurrency = n ? Math.max(1, Math.min(4, Math.round(Number(n)))) : autoReviewConcurrency();
    return reviewConcurrency;
  }
  function getReviewConcurrency() {
    return reviewConcurrency;
  }

  // Re-reviewing the exact same position pair (e.g. switching from fast to
  // deep mode on a game already reviewed once this session, or reopening the
  // review panel) shouldn't re-run a whole search from scratch. Keyed on the
  // full before/after board content plus mover color and the active speed
  // mode (fast vs deep can legitimately disagree, so they must not share a
  // cache slot). Capped so a long session hopping between many different
  // games doesn't grow this without bound.
  const CLASSIFY_CACHE_MAX = 500;
  const classifyCache = new Map();

  function classifyCacheKey(beforeBoard, moverColor, afterBoard) {
    return reviewSpeedMode + "|" + moverColor + "|" + JSON.stringify(beforeBoard) + "|" + JSON.stringify(afterBoard);
  }

  async function classifyPlyCached(engine, beforeBoard, moverColor, afterBoard, skipCache) {
    const key = classifyCacheKey(beforeBoard, moverColor, afterBoard);
    if (!skipCache && classifyCache.has(key)) return classifyCache.get(key);
    const result = await classifyPly(engine, beforeBoard, moverColor, afterBoard);
    if (result) {
      classifyCache.set(key, result);
      if (classifyCache.size > CLASSIFY_CACHE_MAX) {
        classifyCache.delete(classifyCache.keys().next().value); // evict oldest (Map preserves insertion order)
      }
    }
    return result;
  }

  function clearClassifyCache() {
    classifyCache.clear();
  }

  // Shared by both review entry points below: walks a list of before/after
  // board snapshots (one pair per ply) and classifies each one. Plies are
  // independent positions (nothing about ply k's classification depends on
  // ply k-1's result), so a small pool of them run concurrently instead of
  // strictly one after another -- this is what makes a 40-80 move game
  // reviewable in a reasonable time instead of one search's worth of delay
  // multiplied by the ply count.
  async function reviewPositions(engine, positions, cardBetween, onProgress, skipCache) {
    const total = positions.length - 1;
    const plies = new Array(total);
    let nextIndex = 1;
    let completed = 0;

    async function classifyOne(k) {
      const moverColor = k % 2 === 1 ? "white" : "black";
      if (cardBetween[k]) return classifyCardTurn(engine, positions[k - 1], moverColor, positions[k]);
      const result = await classifyPlyCached(engine, positions[k - 1], moverColor, positions[k], skipCache);
      return result || {
        moverColor,
        from: "-",
        to: "-",
        loss: 0,
        classification: { id: "skipped", icon: "move_forced.svg", label: "분석 불가" }
      };
    }

    async function worker() {
      while (true) {
        const k = nextIndex++;
        if (k > total) return;
        plies[k - 1] = await classifyOne(k);
        completed += 1;
        if (onProgress) onProgress(completed, total);
      }
    }

    const workerCount = Math.max(1, Math.min(getReviewConcurrency(), total));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return {
      plies,
      accuracyWhite: accuracyOf(plies, "white"),
      accuracyBlack: accuracyOf(plies, "black")
    };
  }

  async function runFullGameReview(engine, onProgress, mode, skipCache) {
    reviewSpeedMode = mode === "deep" ? "deep" : "fast";
    if (!isGameOver()) return { error: "게임이 끝난 뒤에만 리뷰할 수 있습니다(치팅 방지)." };
    const history = await collectMoveHistoryPositions();
    if (!history) return { error: "기보를 찾을 수 없습니다." };
    return reviewPositions(engine, history.positions, history.cardBetween, onProgress, skipCache);
  }

  window.__augEngineAnalysis = {
    readBoardFromDOM,
    readTurnFromDOM,
    boardsEqual,
    isGameOver,
    runFullGameReview,
    rowColToSquare,
    squareToRowCol,
    classify,
    makeEngineState,
    classifyPly,
    classifyPlyCached,
    classifyCardTurn,
    setSearchWorkerCount,
    setReviewConcurrency,
    getReviewConcurrency,
    setUseNnueForReview,
    getUseNnueForReview,
    clearClassifyCache,
    CLASSIFICATIONS
  };
})();
