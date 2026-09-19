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
