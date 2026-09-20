# Engine plan (2026-09-19)

Goal: stronger engine at the same time budget, with site-exact rules, and strength proven by measurement.

Root problems: (1) search is very slow (depth 2 = 4-12 s; >50% of time is the root safety checks, not the tree), (2) NNUE labels are mostly draws so it cannot beat the hand-coded eval, (3) measurement is too noisy to see improvements.
Dependency: C (measure) first -> A (speed) -> B (evaluation) -> back to A.

## C. Measurement
- C1 tactics set (`nnue/tactics.js`): needs a reference search that gets deep enough -> depends on A
- C2 bigger matches: 100+ decisive games per comparison (time-extension 96-game match running)
- C3 frozen benchmark for round robins

## A. Speed (each step: results identical via `tools/perf/ab-time.js`, then time saved)
- [x] A1 root immediate-loss check: skip clone+apply for plain moves that cannot remove a royal (1.5x, identical on 20 positions; check `tools/perf/prefilter-check.js`)
- [ ] A2 apply the same idea to the other root checks (flee trap, soft safety, bad flee threat)
- [ ] A3 cheaper `cloneState` (18% self time)
- [ ] A4 cache safety verdicts per position
- [ ] A5 reuse reply lists / faster move generation

## B. Evaluation
- [~] B1 residual training (`RESIDUAL=1`): target = search score - hand-coded score; play with `@hybrid300` (train run in cloud, model `models/resid300-r3p`)
- [ ] B2 retrain on all of round 3 (150k)
- [ ] B3 round 4 with the faster engine (deeper labels)
- [ ] B4 self-play with the improved model (bootstrap)

## D. Upkeep
- rule parity (parrot decision), site-update auto check, Chrome check + consent proof reminders, snapshot deletion (owner)

## Gates
- speed: identical output AND less time
- evaluation: better tactics-set score AND >= 55% of decisive games (100+); otherwise log and do not ship

## Autonomy rules (owner away, 2026-09-19)
- Decide alone; report only big goals reached, big problems, or decisions that are truly the owner's. Defaults: parrot guard stays off; a residual model becomes only a selectable extension model (never the default) unless the owner says otherwise.
- When everything is done: repo-wide code refactor, deletions, push.

## Risks and preparations
- Round-3 self-play checks out master at each 6 h cron start -> an engine change must be proven identical (ab-time, prefilter check, CI) BEFORE push; a wrong change would contaminate round-3 data. If in doubt, gate the change behind an option instead.
- 20 concurrent job limit (self-play uses 8): keep other matches/trainings <= 12 jobs, otherwise runs just queue.
- Extension drift: CI now checks `extension/engine.js` == `engine-merged.js` (`tools/ci/engine-sync.js`); re-sync after every engine edit.
- Silent failures: verify by artifact/log (the model-save bug was found only in the log); re-read logs of every train/match run.
- A residual model may play worse than the hand-coded evaluator: gate = 55% of 100+ decisive games, else log only.
- Data branch push conflicts / size: checkpoints retry with rebase; watch repo size when adding datasets.
- Approval-needing actions (deletes) go last and alone; some are blocked by the auto-mode classifier -> leave them for the owner with the exact command.

## Owner instructions (2026-09-19, late)
- Decide small/medium-risk decisions myself and report them; on high-risk decisions, work on something else and leave it for the owner.
- Parrot (F5): only re-verify that engine == site (no code change).
- Residual model: selectable only (never default). Propose several display names (candidates: Riptide, Undertow, Gale, Monsoon, Cyclone) and pick one.
- FINAL STEP (most important): after everything else -- repo-wide code refactor, deletions, push -- then a FINAL REPORT covering: harvest (what improved, numbers), threats caught (rule/parity risks, data contamination risks), bugs found and fixed, and everything else notable (decisions taken, leftovers, owner-only items).

## Log (autonomous run, 2026-09-20)
- A1 root immediate-loss prefilter (1.6x) + per-search hanging-risk memo + attack memo (1.16x): ~1.85x total on depth-2 positions, output identical (ab-time, search-equiv, eq-exotic, golden, smoke). Extension engine re-synced, CI sync check added.
- Time extension (handcoded, 1500 ms): 22-21 in the 96-game re-match, 40-31 combined with the first 45 games (56%, not significant) -> keep it optional, unproven.
- Residual model (RESIDUAL=1, resid300-r3p, 50k round-3 positions) @hybrid300 vs handcoded: 23-22 (51%) -> no gain yet; retrain on the full round 3.
- Tactics set (nnue/tactics-set.json, 75 positions, reference depth>=3): handcoded 16.0%, Squall@atanh400 16.0%, blend0.8 17.3%, resid@hybrid150 17.3%, resid@hybrid300 18.7% (+-4 pts noise) -> too easy to miss, cannot separate models yet; needs faster search to build a deeper reference.
- Parrot check: parity-actions 0/300 differ; playouts 5/60 diverge (locustSwarm x2 expected, promotionRush x1, brutus x1, plain move x1) -> none parrot-related; leftovers listed in TODO.

## While round 3 finishes (2026-09-20 morning)
Order: (1) rule-fidelity check of the playout divergences (promotionRush, brutus, plain move) -- threats first; (2) card-heavy equivalence set for the speed changes (current checks are card-light); (3) speed A3: cloneState / quiescence ordering, only with identical-output proof; (4) refactor prep: list dead/unused files (legacy/, logs/, audit-data/, tools/perf junk) into a deletion candidate list, no deletion yet; (5) extension: add the residual model as a selectable entry behind the same picker (code ready, ships only if the full-round-3 retrain passes the gate).
Stop conditions: round 3 reaches 150k -> switch to dataset-build -> retrain (RESIDUAL, 3 scales) -> matches (100+ decisive games).

## Engine work plan with risk analysis (2026-09-20)
Rule for every item: (a) prove the search tree is unchanged -- ab-time/ab-cards must match on action, score, NODES and CUTOFFS (stricter than action+score) for >= 30 positions with and without cards, plus eq-exotic, golden-eval, smoke, CI; (b) if it cannot be exact, put it behind an option (default OFF) and only enable it after a 100+ decisive-game match; (c) push only after (a); round-3 self-play checks out master every 6 h.
1. Quiescence: filter to captures BEFORE ordering (order key = score desc, index asc, so the relative order of the subsequence is unchanged; needs actionOrderingScore/isCaptureAction to be pure). Risk: hidden state mutation -> caught by node/cutoff equality. Exact.
2. cloneState: share (do not copy) fields no search step mutates. Risk: an in-place mutation somewhere corrupting the shared parent (the 9/19 stale-cache bug class). Approach: first log which fields applyAction/search ever mutate (instrumented run over many positions); share only fields never mutated; verify with a debug mode that deep-freezes shared fields and throws on write. Exact if the freeze run passes.
3. Incremental hanging risk: only recompute pieces whose threat status can change (moved piece, captured piece, pieces attacked/defended along the affected lines). Risk: high (many special-piece movement rules, attacks depend on board-wide rules). Approach: shadow mode -- compute both, assert equal over thousands of positions (cards and exotic pieces) before using; fall back to full recompute whenever any special piece or effect is present. Do only if 1-2 leave a big cost.
4. Transposition table, LMR/null-move, killers/history: NOT exact (change the tree) -> option flags default OFF, evaluated by matches; not shipped without the gate.
5. Remaining root safety checks: prefilter only where a violation count of 0 is shown over >= 10k cases (prefilter-check pattern).
6. Eval features / card values / label changes: only through the train-and-match gate; never edit evaluateState without golden update + parity check.
Order: 1 -> 2 -> 5 -> (3 if worth it) -> 4 as options.
- 2026-09-20: speed total ~2.2x vs the pre-speed-up engine (ab-cards, 16 positions, cards on): identical action/score/NODES/CUTOFFS. One earlier 11/12 "diff" was load noise (time-dependent deadline checks in root safety, `rootSafetyDeadlineTight`), not a logic change: reruns on an idle machine were 12/12 and 16/16 identical. Rule: run equivalence checks with the machine idle.
- Tried and dropped: hoisting the clonePiece key list (0% gain). cloneState sharing / incremental hanging risk / transposition table etc. still open but now optional (2.2x reached).
- Running: residual retrains at scales 150/300/600 on 129k round-3 positions (models resid150-r3b, resid300-r3b, resid600-r3b) -> matches @hybrid<scale> vs handcoded.

## Strength plan (approved 2026-09-20): order 2 -> 1 -> 4 -> 3 -> 5 -> 6
2 measurement: `match.yml` has `handicap` (remove N pieces from a seed-chosen side per pair; swapped pairs stay fair) -> fewer draws; 200-400 games; wider tactics set later. (handicap implemented; probe of draw rate next)
1 spend the speed: re-measure depth 2 vs 3 vs 4 (handcoded, 1500 ms) with the 2.2x engine, then raise self-play/extension default depth/time accordingly.
4 residual retrain verdict: 3 matches running (resid150/300/600-r3b @hybrid vs handcoded, 128 games each); then full round 3 retrain. Ship only >=55% of 100+ decisive games.
3 hand-coded weight tuning (SPSA/regression on self-play data via tune-eval.js), card values from win rates; golden update + gate required.
5 search options (TT, killers/history, LMR): default OFF, enable only after a match win.
6 bootstrap self-play (round 4) with a gated model.
- Item 3 probe (2026-09-20): regressing the static evaluateState terms onto the logged searchScore does NOT work as a tuning method: searchScore includes per-move heuristic scores (applied.score, tactical adjustments) on top of the minimax eval, so it is not in static-eval units (current weights R2 = -2.3 on 1.4k held-out positions; the "fitted" weights e.g. material 0.135 are just mimicking move bonuses). Would need the deep PV-leaf static eval or outcome-based fitting (noisy). Dropped; item 3 stays open only via outcome-based tuning + match gate.

## Measurement finding (2026-09-20) -- gates revised
Match summary now prints a Wilson 95% interval and the detectable gap: with 45 decisive games only gaps of about +-21 points are reliably detectable; +-5 points needs ~784 decisive games (~1,800 games at a 57% draw rate). So the old gate ">= 55% of 100 decisive games" cannot distinguish 55% from 50%.
Revised gates: SHIP only if the 95% interval's lower bound is > 50% (or, for a speed/no-regression change, the interval excludes a loss of more than ~10 points); otherwise "unproven", keep optional. To get there: handicap matches (fewer draws), 400+ games per candidate, per-move quality score and the tactics set as cheaper second signals.

## Experiment factory (approved to plan 2026-09-20)
Goal: replace "human reads results and decides" with a machine that tries candidates, judges them by matches, and keeps only proven winners.
Order rule: when round-3 self-play ends, its follow-ups go FIRST (or in parallel): dataset-build round3-full -> retrain (residual 150/300/600 + a non-residual control) -> matches. The factory is built in parallel/after, never blocking these.

L0 outcome: an unattended loop candidate -> match -> verdict -> promote, with hard stop rules.
L1 blocks
  F  Lab (judge): a reusable judging workflow. Input: candidate spec vs baseline spec. Runs fixed balanced openings + handicap pairs, sequential test (SPRT-like) until the interval excludes/settles, prints a verdict file (win / lose / unproven, interval, games, draw rate) and stops early.
  C  Candidate generators: (1) residual retrains at several scales, (2) search options behind flags (TT, killers/history, LMR, time management), (3) depth/time presets.
  L  Loop (autopilot): scheduled/dispatched cycle selfplay(best) -> dataset -> train -> lab -> promote if verdict = win. Round 4+ run through it.
  W  Watchdog: site-patch detector -> parity run -> diff report.
L2 steps (first block F)
  F1 fixed opening set: choose N balanced seeds from a probe (handicap 0/1/2 draw-rate probe; keep the setting that gives the most decisive games without a one-sided result)
  F2 verdict logic: Wilson interval + stop rules (max games, min games, decisive target); machine-readable verdict.json artifact
  F3 batch runner: one dispatch runs several candidates against the baseline and collects verdicts into one summary
  F4 result log in the repo (docs/results/*.json: spec, games, interval, date) -- reproducible
L3 details (F1): match-two-models gets MATCH_OPENINGS (seed list file); match.yml input `openings`; probe = handcoded vs handcoded and depth3 vs depth2 at handicap 0/1/2.
Stop rules for anything unattended: hard cap on jobs per cycle (<= 12 concurrent), max cycles per day, abort a cycle on any failed step, never touch master engine/extension files without a `win` verdict + CI green, data-branch size check before pushing datasets.
Owner involvement: approve the rules once; read the final summary.
- Lab F2-F4 done (2026-09-20): `match.yml` writes verdict.json (win/lose/unproven from the 95% interval) as artifact `match-verdict`; `tools/lab/lab.js` dispatches a batch of candidates (`dispatch`), lists runs (`status`) and appends finished verdicts to `docs/results/results.jsonl` (`collect`). Example: tools/lab/example-candidates.json. Remaining: F1 opening/handicap choice (probe running), loop L, candidate generators C (search flags), watchdog W.
