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
