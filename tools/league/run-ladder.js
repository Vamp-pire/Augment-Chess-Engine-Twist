// Dispatcher for a set of match.yml runs (round-robin or gauntlet). DRY RUN by default:
// it only prints the `gh workflow run` commands; pass --go to really dispatch them.
//
//   node tools/league/run-ladder.js                                   # default ladder handcoded@d2..d5, round-robin, dry run
//   node tools/league/run-ladder.js handcoded@d3 data:models/x.json   # any participants (models use --depth, default 3)
//   node tools/league/run-ladder.js --with-ladder data:models/x.json --mode gauntlet --gauntlet handcoded@d3 --go
//   node tools/league/run-ladder.js --collect <manifest.json> <outdir>   # gh run download match-result of finished runs
//
// Participant syntax: <model spec>[@d<N>|@depth<N>]; the model spec is what match.yml takes
// (repo weights path, data:<path on gha-segments-16cards>, handcoded, optionally with @<output map>).
// "handcoded@d4" = the hand-coded evaluator searched at depth 4; the depth suffix is only recognised
// at the end, so "x.json@atanh400@d4" also works. Participant label (used by league.js) = spec + "/d" + depth.
//
// Options (defaults): --mode roundrobin|gauntlet  --gauntlet <participant> (first one)  --depth 3
//   --shards 20 (1-20)  --pairs 5 (pairs per shard; games per match = shards x pairs x 2)  --ms 300
//   --handicap 0  --seed-offset 0  --input key=value (extra match.yml input, repeatable, e.g. full_piece_state=1)
//   --manifest <file>  --repo owner/name  --ref <branch, default master>  --go
// Runs are dispatched sequentially; the new run id is found by diffing `gh run list` (a run started
// by someone else in the same seconds could be mistaken, so the manifest stores the inputs too).
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const WORKFLOW = "match.yml";
const DEFAULT_LADDER = ["handcoded@d2", "handcoded@d3", "handcoded@d4", "handcoded@d5"];

function parseParticipant(text, defaultDepth) {
  const m = /^(.*)@d(?:epth)?(\d+)$/.exec(text);
  const spec = m ? m[1] : text;
  const depth = m ? Number(m[2]) : defaultDepth;
  return { text, spec, depth, label: spec + "/d" + depth };
}

function planMatches(participants, mode, gauntlet) {
  const out = [];
  if (mode === "gauntlet") {
    const g = participants.find((p) => p.text === gauntlet || p.label === gauntlet) || participants[0];
    for (const p of participants) if (p !== g) out.push([p, g]);
  } else {
    for (let i = 0; i < participants.length; i += 1) for (let j = i + 1; j < participants.length; j += 1) out.push([participants[i], participants[j]]);
  }
  return out;
}

function inputsFor(a, b, o) {
  const inp = { model_a: a.spec, model_b: b.spec, shards: String(o.shards), pairs_per_shard: String(o.pairs), depth: String(o.depth), depth_a: String(a.depth), depth_b: String(b.depth), ms: String(o.ms) };
  if (Number(o.handicap)) inp.handicap = String(o.handicap);
  if (Number(o.seedOffset)) inp.seed_offset = String(o.seedOffset);
  for (const kv of o.inputs) { const i = kv.indexOf("="); inp[kv.slice(0, i)] = kv.slice(i + 1); }
  return inp;
}
function ghArgs(inputs, o) {
  const args = ["workflow", "run", WORKFLOW, "--ref", o.ref];
  if (o.repo) args.push("-R", o.repo);
  for (const [k, v] of Object.entries(inputs)) args.push("-f", k + "=" + v);
  return args;
}
const shq = (s) => (/^[A-Za-z0-9_@:=.,\/+-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'");

function gh(args) {
  const r = spawnSync("gh", args, { encoding: "utf8", shell: false });
  if (r.status !== 0) throw new Error("gh " + args.join(" ") + " failed: " + (r.stderr || r.stdout || r.error));
  return r.stdout;
}
function recentIds(repo) {
  const args = ["run", "list", "--workflow", WORKFLOW, "--limit", "40", "--json", "databaseId"];
  if (repo) args.push("-R", repo);
  return JSON.parse(gh(args)).map((r) => r.databaseId);
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function stamp() { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }

function parseArgs(argv) {
  const o = { mode: "roundrobin", gauntlet: null, depth: 3, shards: 20, pairs: 5, ms: 300, handicap: 0, seedOffset: 0, inputs: [], manifest: null, repo: null, ref: "master", go: false, withLadder: false, collect: null, participants: [] };
  const num = new Set(["depth", "shards", "pairs", "ms", "handicap"]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--go") o.go = true;
    else if (a === "--with-ladder") o.withLadder = true;
    else if (a === "--collect") { o.collect = [argv[i + 1], argv[i + 2]]; i += 2; }
    else if (a === "--input") o.inputs.push(argv[++i]);
    else if (a === "--seed-offset") o.seedOffset = Number(argv[++i]);
    else if (a.startsWith("--")) {
      const k = a.slice(2);
      if (!["mode", "gauntlet", "depth", "shards", "pairs", "ms", "handicap", "manifest", "repo", "ref"].includes(k)) throw new Error("unknown option " + a);
      o[k] = num.has(k) ? Number(argv[++i]) : argv[++i];
    } else o.participants.push(a);
  }
  if (!Number.isInteger(o.shards) || o.shards < 1 || o.shards > 20) throw new Error("--shards must be 1-20");
  if (!(o.pairs >= 1)) throw new Error("--pairs must be >= 1");
  if (!["roundrobin", "gauntlet"].includes(o.mode)) throw new Error("--mode must be roundrobin or gauntlet");
  return o;
}

function collect(manifestPath, outDir) {
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.mkdirSync(outDir, { recursive: true });
  for (const r of m.runs) {
    if (!r.runId) { console.log("skip (no run id):", r.labelA, "vs", r.labelB); continue; }
    const dest = path.join(outDir, String(r.runId));
    if (fs.existsSync(path.join(dest, "match-result.json"))) { console.log("have", r.runId); continue; }
    try { gh(["run", "download", String(r.runId), "-n", "match-result", "-D", dest].concat(m.repo ? ["-R", m.repo] : [])); console.log("downloaded", r.runId, r.labelA, "vs", r.labelB); }
    catch (e) { console.log("not available yet:", r.runId, r.labelA, "vs", r.labelB, "(" + String(e.message).split("\n")[0].slice(0, 100) + ")"); }
  }
  console.log("next: node tools/league/league.js " + outDir);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.collect) return collect(o.collect[0], o.collect[1]);
  let texts = o.participants.slice();
  if (!texts.length || o.withLadder) texts = DEFAULT_LADDER.concat(texts);
  texts = [...new Set(texts)];
  const participants = texts.map((t) => parseParticipant(t, o.depth));
  const labels = participants.map((p) => p.label);
  if (new Set(labels).size !== labels.length) throw new Error("duplicate participants after depth resolution: " + labels.join(", "));
  const matches = planMatches(participants, o.mode, o.gauntlet);
  const gamesPer = o.shards * o.pairs * 2;
  console.log(`${o.mode}: ${participants.length} participants (${labels.join(", ")}), ${matches.length} matches x ${gamesPer} games = ${matches.length * gamesPer} games` + (o.go ? "" : "  [DRY RUN, pass --go to dispatch]"));
  const plan = matches.map(([a, b]) => { const inputs = inputsFor(a, b, o); return { a, b, inputs, args: ghArgs(inputs, o) }; });
  if (!o.go) {
    for (const p of plan) console.log("gh " + p.args.map(shq).join(" "));
    return;
  }
  const manifestPath = o.manifest || path.join(__dirname, "manifests", "ladder-" + stamp() + ".json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const manifest = { created: new Date().toString(), mode: o.mode, repo: o.repo, ref: o.ref, options: { shards: o.shards, pairs: o.pairs, ms: o.ms, handicap: o.handicap, seedOffset: o.seedOffset, depth: o.depth }, runs: [] };
  const save = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  let known = new Set(recentIds(o.repo));
  for (const p of plan) {
    const entry = { labelA: p.a.label, labelB: p.b.label, inputs: p.inputs, runId: null };
    manifest.runs.push(entry);
    gh(p.args);
    for (let t = 0; t < 20 && !entry.runId; t += 1) {
      sleep(3000);
      const fresh = recentIds(o.repo).filter((id) => !known.has(id));
      if (fresh.length) entry.runId = Math.max(...fresh);
    }
    known = new Set(recentIds(o.repo));
    save();
    console.log("dispatched", p.a.label, "vs", p.b.label, "-> run", entry.runId || "(id not found; see gh run list)");
  }
  console.log("manifest:", manifestPath);
  console.log("when finished: node tools/league/run-ladder.js --collect " + manifestPath + " results && node tools/league/league.js results");
}

module.exports = { parseParticipant, planMatches, inputsFor, ghArgs };
if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
