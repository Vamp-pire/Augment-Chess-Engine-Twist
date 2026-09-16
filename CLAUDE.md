# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome/Edge MV3 extension (`extension/`) that adds a self-built search engine + Stockfish + NNUE analysis overlay to **augmentchess.org**, a chess-variant site with ~240 cards and dozens of custom piece types. Alongside the extension, this repo also contains a completely separate Node.js pipeline (self-play generation + NNUE training) used to produce the evaluator the extension optionally uses.

There is no build step, bundler, package manifest scripts, linter, or test framework — `package.json` only lists the two `@tensorflow/tfjs*` deps. Verification is done by running smoke/self-play scripts directly with `node` and checking their output (see Commands).

## Commands

```bash
# Syntax-check the engine after any edit (fast sanity check, always do this)
node -c engine-merged.js

# Smoke-test engine-merged.js in isolation (loading convention below)
node smoke-merged.js

# Run a short local self-play batch against engine-merged.js (worker_threads)
node selfplay-batch-merged.js [gameCount]      # default 8 games

# Run the real self-play data-generation pipeline for a fixed duration
node selfplay-run-merged.js <ms>               # writes to selfplay-data.jsonl by default
SELFPLAY_OUT_FILE=out.jsonl node selfplay-run-merged.js 600000   # override output path
SELFPLAY_SEARCH_DEPTH=5 SELFPLAY_SEARCH_MS=200 node selfplay-run-merged.js 600000  # override search budget

# Train the NNUE model on selfplay-data.jsonl (fixed path: ../selfplay-data.jsonl relative to nnue/)
cd nnue && node train.js
NNUE_VARIANT=old node train.js                 # ablation variants: old | linear | new(default)
ABLATE_DEEP_UNITS=32 ABLATE_WARM_START=0 ABLATE_OVERSAMPLE=1.0 ABLATE_BLEND=0.4 ABLATE_BLUNDER=0 node train.js
```

Any script that touches game logic (`engine-merged.js`, `selfplay-worker-merged.js`, `site-oracle/*.mjs`) must be loaded with the same stub sequence before `require`/`import`, since none of this code has a DOM:
```js
globalThis.self = globalThis;
globalThis.addEventListener = () => {};
const engine = require("./engine-merged.js");
```

## Architecture

### Two independent engines — do not confuse them

- **`extension/engine.js`** — the engine actually shipped to users in the live extension. A hand-ported reimplementation of the site's rules, evolved independently since the project started. **Not kept in sync with `engine-merged.js`** — this was a deliberate decision after an audit found the hand-port had real bugs/omissions; fixing it in place was judged too risky mid-session, so it was left alone and superseded for training purposes only (see below).
- **`engine-merged.js`** — the authoritative engine for self-play and NNUE training. Built from `site-oracle/aiWorker-raw.js` (the site's real, unminified search worker, fetched from `https://augmentchess.org/assets/aiWorker.js`) with a curated set of original additions grafted in: search-quality improvements (quiescence, null-move pruning, killer moves) and card-awareness safety heuristics that don't exist in the site's own code. `audit-data/graft-progress.md` has the per-function grafting log with a GRAFTED/NOT-NEEDED verdict for each candidate.

**Grafting discipline** (apply this to any future engine/rules work): a card or mechanic is implemented from the real site bundle's own logic, never guessed from its Korean description — a bundle citation (file + line/function name) is required before code is written. When real source genuinely can't be found, a description-based fallback is allowed but must be flagged explicitly as such, never silently mixed in with verified ports.

### `site-oracle/` — the ground-truth extraction technique

augmentchess.org's production JS bundle is **not minified/mangled** (real names, Korean strings intact), so it can be `curl`'d, patched with a few browser-global stubs (see `site-oracle/README.md` and `init.mjs`), and run directly in Node as an oracle for what the real rules actually do — this is how card/piece bugs in the hand-ported engines get found and fixed with certainty instead of by reading minified/obfuscated code or guessing from UI text. `aiWorker-raw.js` is kept byte-for-byte as fetched (never hand-edited) as the reference; re-fetch it fresh (URL above) whenever the site patches, since the bundle filename/hash changes on every site deploy.

### NNUE pipeline

- `nnue/encode.js` — feature encoding (board planes + card one-hot + named features). Its `SPECIAL_TYPES`/`CARD_POOL_TYPES` lists **must exactly match** `selfplay-worker-merged.js`'s `SELFPLAY_SPECIAL_TYPES`/`SELFPLAY_CARD_POOL` — any drift between them silently produces all-zero input planes for the missing type rather than an error. `INPUT_SIZE` changes whenever either list grows, which makes any previously-trained `weights.json` shape-incompatible (must retrain from scratch).
- `nnue/train.js` — TensorFlow.js (wasm backend) training script; wide-and-deep architecture (a direct linear path from raw input, summed with a 2-hidden-layer path, before a final `tanh`) chosen to warm-start from `evaluateState()`'s own hand-picked coefficients (`ORIGINAL_EVAL_WEIGHTS`) rather than from scratch. Reads `DATA_FILE = ../selfplay-data.jsonl` (fixed path, no CLI override — swap the file in place or symlink it).
- `nnue/forward.js` and **`extension/nnue.js`** both hand-implement the exact same forward pass as `train.js`'s model — there is no shared source between the Node training code and the browser copy, so an architecture change in one requires manually porting it to the other(s) bit-for-bit, or the loaded weights are meaningless. `extension/nnue.js` is deliberately **not** updated in lockstep with `nnue/encode.js` — it stays pinned to whatever `INPUT_SIZE`/feature layout the currently-deployed `model/nnue-weights.json` was trained with, and both are only swapped together once a new model has been trained *and* validated on the new shape.

### Self-play data generation

`selfplay-worker-merged.js` (one worker_threads game, using `engine-merged.js` for both sides) + `selfplay-run-merged.js` (spawns `os.cpus().length - 1` workers in parallel for a fixed wall-clock duration, writes newline-delimited JSON to `SELFPLAY_OUT_FILE`). `SELFPLAY_CARD_POOL`/`SELFPLAY_SPECIAL_TYPES` in the worker file are the full catalog of cards/pieces self-play is allowed to draw — cards behind unmet prerequisites (a piece type self-play never places, a RULE-category card, etc.) are deliberately excluded there with a comment explaining why, not silently dropped.

Large `selfplay-data*.jsonl` output files are gitignored (git has no room for 100MB+ blobs). Cloud-generated data instead goes to `.github/workflows/selfplay.yml`, which runs self-play on a schedule and pushes small, incremental gzip checkpoints (via a separate git worktree, never touching the branch the job checked out) to a dedicated `gha-segments-16cards` branch — see the workflow file's own comments for the checkpoint-interval and retry logic. Any change to this workflow's git plumbing should be verified by reproducing the exact commands locally against the real remote branch before pushing, since a workflow bug here fails silently (self-play still runs; only the backup step is broken) and is expensive to notice.

### Extension runtime (`extension/`)

- Content scripts run in the page's **MAIN world** (not the default ISOLATED world) so `window.Worker`/`window.AugmentEngine` etc. are actually shared with the real page; `ext-bridge.js` is the one ISOLATED-world script (runs first, at `document_start`) and hands off the extension's base URL via a `dataset` attribute on `<html>`, since that's the only thing that crosses the world boundary cleanly.
- Stockfish runs inside a `chrome.offscreen` document (`background.js` hosts it), not an in-page iframe — the iframe approach was replaced after a full day of unreproducible handshake failures once content scripts moved to MAIN world; see `background.js`'s header comment for the full story before reintroducing anything iframe-based.
- `engine.js` (hand-coded eval + search) and `nnue.js` (optional pluggable NNUE evaluator) are independent; `hybrid.js`/`analysis.js` combine them for the live-play and post-game review features respectively.
