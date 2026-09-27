#!/usr/bin/env node
// One command for the routine work when augmentchess.org updates (local only; nothing is pushed, no workflow is started).
//   1. detect (main page only) + download the new worker/bundle, only when the bundle name differs from last-seen.json
//   2. make-fast-worker.js (speed patch layer) + diff-fast-worker.js (must show 0 divergences)
//   3. parity-actions / parity-apply / parity-playout against the NEW worker and the PREVIOUS worker (.cache/real-worker.prev.js)
//   4. short report: patch layer, mismatch counts old -> new by card, which are not in known-mismatches.json, recommendation
// Usage: node update-site.js [--force-network] [--save]
//   --force-network  ignore the 6-hour minimum interval and the "bundle unchanged" shortcut (still max 5 requests, no retries)
//   --save           after a successful run, rewrite last-seen.json with the freshly downloaded values (only with fresh network data)
// Exit code: 0 ok (record only), 1 patch layer failed, 2 new mismatches, 3 network/test-run error.
// Never touches engine-merged.js, git, GitHub or any other repository. Safety: see net-guard.js (request cap, User-Agent, lock).
const fs = require("fs"), path = require("path"), crypto = require("crypto"), cp = require("child_process");
const guard = require("./net-guard");
const check = require("./check-site-update");
const fetcher = require("./fetch-real-worker");

const HERE = __dirname;
const KNOWN_FILE = path.join(HERE, "known-mismatches.json");
// Fixed sizes/seeds so runs are comparable (parity scripts otherwise rotate the seed by date).
const TESTS = [
  { id: "actions", label: "parity-actions", script: "parity-actions.js", args: ["-", "400", "12345"], env: {} },
  { id: "apply", label: "parity-apply", script: "parity-apply.js", args: ["-", "300", "777"], env: {} },
  { id: "playout", label: "parity-playout", script: "parity-playout.js", args: ["-", "100", "4242", "40"], env: { SEED_RANDOM: "1" } },
];
const DIFF_ARGS = ["80", "4242", "120"];
const PROC_TIMEOUT_MS = 15 * 60 * 1000;

const fmtKST = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Seoul", hour12: false }).slice(0, 16) + " KST";
const fmtAge = (ms) => (ms < 90 * 60 * 1000 ? Math.round(ms / 60000) + "분" : (ms / 3600000).toFixed(1) + "시간");
const sha256File = (f) => { try { return crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"); } catch { return null; } };

function defaultPaths(cacheDir = guard.CACHE_DIR) {
  return {
    cacheDir, lockFile: path.join(cacheDir, "network-lock.json"), seenFile: check.SEEN,
    raw: path.join(cacheDir, "aiWorker.raw.js"), real: path.join(cacheDir, "real-worker.js"),
    prev: path.join(cacheDir, "real-worker.prev.js"), fast: path.join(cacheDir, "real-worker-fast.js"),
  };
}

// ---------- step 1: network ----------
async function networkPhase({ forceNetwork = false, paths, nowMs, createNet }) {
  const old = check.loadSeen(paths.seenFile);
  let fallbackMs = old?.checkedAt ? Date.parse(old.checkedAt) : null; // bootstrap when no lock file exists yet
  try { const m = fs.statSync(paths.raw).mtimeMs; if (!(fallbackMs > m)) fallbackMs = m; } catch {}
  const lock = guard.lockStatus({ lockFile: paths.lockFile, nowMs, fallbackMs: Number.isFinite(fallbackMs) ? fallbackMs : null });
  if (lock.blocked && !forceNetwork) return { mode: "locked", old, lock, requests: 0 };
  const net = createNet();
  try {
    const mainBundle = check.parseIndex(await net.get(check.SITE + "/"));
    if (old && old.mainBundle === mainBundle && !forceNetwork) return { mode: "unchanged", old, lock, requests: net.count(), mainBundle };
    const worker = await net.get(fetcher.WORKER_URL);
    const main = await net.get(check.SITE + "/assets/" + mainBundle);
    const fresh = check.buildFresh({ mainBundle, worker, main, now: new Date(nowMs) });
    const cachedSha = sha256File(paths.raw) || old?.aiWorkerSha256 || null;
    let rotated = false;
    if (cachedSha !== fresh.aiWorkerSha256 && fs.existsSync(paths.real)) { fs.copyFileSync(paths.real, paths.prev); rotated = true; } // keep the version before this download as the baseline
    fetcher.writeWorkerFiles(new TextDecoder("utf-8").decode(worker), { raw: paths.raw, out: paths.real });
    return { mode: "downloaded", old, lock, requests: net.count(), fresh, changed: check.isChanged(old, fresh), rotated };
  } catch (e) {
    return { mode: "error", old, lock, requests: net.count(), error: e.message }; // no retry: stop and report
  }
}

// ---------- process helpers (max 2 in parallel: parity new + previous) ----------
function run(script, args, env, cwd = HERE) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    cp.execFile(process.execPath, [path.join(HERE, script), ...args], { cwd, env: { ...process.env, ...env }, timeout: PROC_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : (err.killed ? "timeout" : 1)) : 0, stdout: String(stdout || ""), stderr: String(stderr || ""), ms: Date.now() - t0 });
    });
  });
}
const cleanEnv = (extra = {}) => ({ REAL_WORKER_PATH: "", ...extra }); // "" = unset for common.js (falsy)

// ---------- step 2: patch layer ----------
async function patchLayer() {
  const mk = await run("make-fast-worker.js", [], cleanEnv());
  if (mk.code !== 0) {
    const msg = (mk.stderr || mk.stdout).trim().split("\n").pop();
    const m = msg.match(/patch "([^"]+)": anchor matched (\d+) times/);
    return { ok: false, stage: "make-fast-worker", anchor: m ? m[1] : null, detail: msg };
  }
  const applied = mk.stdout.match(/\((\d+)\/(\d+) patches/);
  const df = await run("diff-fast-worker.js", DIFF_ARGS, cleanEnv());
  const tot = df.stdout.match(/TOTAL divergences=(\d+)/);
  const divergences = tot ? Number(tot[1]) : null;
  if (divergences !== 0) return { ok: false, stage: "diff-fast-worker", divergences, applied: applied ? applied.slice(1, 3).map(Number) : null, detail: divergences === null ? (df.stderr || df.stdout).trim().split("\n").pop() : df.stdout.split("\n").find((l) => /diff|differs|DIVERG/i.test(l)) || "" };
  return { ok: true, applied: applied ? applied.slice(1, 3).map(Number) : null, divergences, ms: mk.ms + df.ms };
}

// ---------- step 3: parity ----------
function parseParity(id, out) {
  const line = out.split("\n")[0] || "";
  const num = (re) => { const m = line.match(re); return m ? Number(m[1]) : null; };
  const json = (re) => { const m = line.match(re); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } };
  let total, byRaw;
  if (id === "playout") { total = num(/diverged=(\d+)/); byRaw = json(/byCause=(\{.*\})\s*$/); }
  else { total = num(/differing=(\d+)/); byRaw = json(/byAction=(\{.*\})\s*$/); }
  if (total === null || byRaw === null) return null;
  const byKey = {};
  for (const [k, v] of Object.entries(byRaw)) { const key = id === "playout" ? k.split(" after ").pop().replace(/^card:/, "").replace(/:$/, "") : k.replace(/^card:/, ""); byKey[key] = (byKey[key] || 0) + v; }
  return { total, byKey, errors: num(/errors=(\d+)/) || 0, line: line.slice(0, 200) };
}
async function parityAgainst(t, workerPath) {
  const r = await run(t.script, t.args, cleanEnv({ ...t.env, REAL_WORKER_PATH: workerPath || "" }));
  const parsed = r.code === 0 ? parseParity(t.id, r.stdout) : null;
  return parsed ? { ...parsed, ms: r.ms } : { failed: true, detail: (r.stderr || r.stdout).trim().split("\n").slice(0, 2).join(" | ").slice(0, 300) || "exit " + r.code };
}
async function parityLayer(paths) {
  const sameAsPrev = fs.existsSync(paths.prev) && sha256File(paths.prev) === sha256File(paths.real);
  const hasPrev = fs.existsSync(paths.prev);
  const results = [];
  for (const t of TESTS) {
    const [nw, ol] = await Promise.all([parityAgainst(t, ""), hasPrev && !sameAsPrev ? parityAgainst(t, paths.prev) : Promise.resolve(null)]);
    results.push({ test: t, new: nw, old: sameAsPrev ? nw : ol });
  }
  return { results, hasPrev, sameAsPrev };
}

// ---------- classification (pure) ----------
function classify(results, known) {
  const slack = known.regressionSlack || { min: 3, ratio: 0.5 };
  const flags = [];
  for (const { test, new: nw, old } of results) {
    if (!nw || nw.failed) continue;
    for (const [key, n] of Object.entries(nw.byKey)) {
      const o = old && !old.failed ? (old.byKey[key] || 0) : null;
      if (!(key in known.known)) flags.push({ key, test: test.id, kind: "unlisted", old: o, new: n });
      else if (o !== null && n > o + Math.max(slack.min, Math.ceil(slack.ratio * o))) flags.push({ key, test: test.id, kind: "increased", old: o, new: n });
    }
  }
  const keys = [...new Set(flags.map((f) => f.key))];
  return { flags, keys, count: keys.length };
}

// ---------- step 4: report ----------
function buildReport({ nowMs, net, patch, parity, cls, known, exitCode, saveNote, cacheInfo }) {
  const L = [];
  L.push(`== 사이트 업데이트 점검 (${fmtKST(nowMs)}) ==`);
  const seen = net.old;
  const fresh = net.fresh;
  if (net.mode === "locked") L.push(`네트워크: 요청 안 함 (마지막 사이트 요청 ${fmtKST(net.lock.lastMs)}, ${fmtAge(net.lock.ageMs)} 전 < 6시간). 캐시 파일 사용.`);
  else if (net.mode === "unchanged") L.push(`네트워크: 메인 페이지 1회 요청(총 ${net.requests}회). 번들 ${net.mainBundle} = last-seen과 같음 -> 워커는 받지 않음, 캐시 파일 사용. (번들 이름은 그대로인데 aiWorker.js만 바뀐 경우는 이 빠른 확인으로 못 봅니다: --force-network)`);
  else if (net.mode === "error") L.push(`네트워크 오류로 중단: ${net.error} (요청 ${net.requests}회, 재시도 안 함. 6시간 안에는 다시 요청하지 않으니 캐시로 돌리거나 --force-network 로 직접 다시 시도하세요.)`);
  else if (net.mode === "downloaded") L.push(`네트워크: ${net.requests}회 요청 (상한 ${guard.MAX_REQUESTS}회). ${net.changed ? "last-seen과 다름 = 새 업데이트" : "last-seen과 같음"}${net.rotated ? ", 이전 워커를 real-worker.prev.js로 보관" : ""}.`);
  const site = fresh || seen;
  if (site) L.push(`사이트: 업데이트 로그 ${site.updateLogVersion || "?"} / 번들 ${site.mainBundle} / aiWorker ${String(site.aiWorkerSha256).slice(0, 12)}${fresh ? "" : " (last-seen.json에 기록된 값)"}`);
  if (net.mode === "locked") L.push(`캐시된 워커: ${cacheInfo.rawSha ? cacheInfo.rawSha.slice(0, 12) : "?"}${seen && cacheInfo.rawSha ? (cacheInfo.rawSha === seen.aiWorkerSha256 ? " = last-seen과 같음" : " != last-seen (" + String(seen.aiWorkerSha256).slice(0, 12) + ")") : ""}`);
  L.push(`이전 워커(baseline): ${cacheInfo.hasPrev ? (cacheInfo.sameAsPrev ? "현재 워커와 같음(비교 결과 동일)" : "real-worker.prev.js " + (cacheInfo.prevSha || "").slice(0, 12)) : "없음 -> '이전' 열 없이 목록 대조만"}`);
  if (patch) L.push(patch.ok ? `속도 패치 레이어: OK (${patch.applied ? patch.applied.join("/") : "?"} 패치, diff-fast-worker ${DIFF_ARGS.join("x")} 차이 0)` : `속도 패치 레이어: 실패 [${patch.stage}]${patch.anchor ? " 앵커 \"" + patch.anchor + "\"" : ""}${patch.divergences != null ? " 차이 " + patch.divergences + "건" : ""} ${patch.detail || ""}`.trim());
  if (parity) {
    L.push("불일치 (새 워커 / 이전 워커), 카드별 [알려짐=목록에 있음]:");
    for (const { test, new: nw, old } of parity.results) {
      const sz = test.args.slice(1).join(" ");
      if (nw.failed) { L.push(`  ${test.label} ${sz}: 실행 실패 - ${nw.detail}`); continue; }
      const oldTxt = old ? (old.failed ? "실행 실패" : String(old.total)) : "-";
      const keys = [...new Set([...Object.keys(nw.byKey), ...Object.keys(old && !old.failed ? old.byKey : {})])].sort((a, b) => (nw.byKey[b] || 0) - (nw.byKey[a] || 0));
      const parts = keys.map((k) => `${k} ${nw.byKey[k] || 0}/${old && !old.failed ? (old.byKey[k] || 0) : "-"}${k in known.known || !nw.byKey[k] ? "" : " [목록에 없음]"}`);
      L.push(`  ${test.label} ${sz}: ${nw.total} / ${oldTxt}${nw.errors ? ` (오류 ${nw.errors})` : ""}${parts.length ? " -> " + parts.join(", ") : ""}`);
    }
    if (cls.flags.length) {
      L.push("주의가 필요한 불일치:");
      for (const f of cls.flags) L.push(`  ${f.key} (${f.test}): ${f.kind === "unlisted" ? "알려진 목록에 없음" : "알려진 것인데 늘어남"} ${f.new} / ${f.old === null ? "-" : f.old}`);
    } else L.push("목록에 없는 불일치, 늘어난 불일치: 없음");
  }
  let rec;
  if (exitCode === 3) rec = "권고: 점검을 끝내지 못했습니다(위 오류 확인). 아무것도 저장하지 않았습니다.";
  else if (patch && !patch.ok) rec = "권고: 사람이 개입해야 합니다 - 속도 패치 앵커를 다시 잡고(make-fast-worker.js 주석의 근거를 새 사이트 코드로 다시 확인) diff-fast-worker 차이 0을 확인하세요.";
  else if (cls.count === 0) rec = "권고: 기록만 (엔진 이식 불필요). 확인 후 --save 로 last-seen.json 갱신.";
  else rec = `권고: 엔진 이식 필요: 새 불일치 ${cls.count}개 (${cls.keys.join(", ")})${cls.count >= known.humanThreshold ? ` - ${known.humanThreshold}개 이상이므로 사람이 검토해야 합니다(기준은 known-mismatches.json의 humanThreshold, 이식은 모아서 나중에 해도 됨)` : ` - ${known.humanThreshold}개 미만이라 급하지 않음, 모아서 이식해도 됨`}.`;
  L.push(rec);
  if (saveNote) L.push(saveNote);
  L.push(`종료 코드 ${exitCode} (0 정상, 1 패치 실패, 2 새 불일치, 3 네트워크/실행 오류)`);
  return L.join("\n");
}

// ---------- main ----------
async function main(argv, deps = {}) {
  const forceNetwork = argv.includes("--force-network"), save = argv.includes("--save");
  const paths = deps.paths || defaultPaths();
  const now = deps.now || Date.now;
  const createNet = deps.createNet || (() => guard.createNet({ lockFile: paths.lockFile }));
  const steps = { patchLayer, parityLayer, ...(deps.steps || {}) };
  const out = deps.out || ((s) => console.log(s));
  const known = JSON.parse(fs.readFileSync(deps.knownFile || KNOWN_FILE, "utf8"));
  const nowMs = now();

  const net = await networkPhase({ forceNetwork, paths, nowMs, createNet });
  if (net.mode === "error") {
    out(buildReport({ nowMs, net, patch: null, parity: null, cls: { flags: [], keys: [], count: 0 }, known, exitCode: 3, cacheInfo: {} }));
    return 3;
  }
  if (!fs.existsSync(paths.real)) { out(`캐시된 워커가 없습니다(${paths.real}). 네트워크 없이는 점검할 수 없으니 --force-network 로 실행하세요.`); return 3; }

  const patch = await steps.patchLayer(paths);
  const parity = await steps.parityLayer(paths);
  const cls = classify(parity.results, known);
  const testFailed = parity.results.some((r) => r.new.failed);
  const exitCode = !patch.ok ? 1 : testFailed ? 3 : cls.count > 0 ? 2 : 0;

  let saveNote = null;
  if (save) {
    if (net.mode !== "downloaded") saveNote = "--save: 이번 실행에 새로 받은 값이 없어 last-seen.json을 바꾸지 않았습니다(--force-network --save 로 다시 실행).";
    else if (exitCode === 1 || exitCode === 3) saveNote = "--save: 패치 실패/실행 오류라 last-seen.json을 바꾸지 않았습니다.";
    else { check.saveSeen(net.fresh, paths.seenFile); saveNote = "--save: last-seen.json 갱신함 (커밋은 직접)."; }
  } else if (net.mode === "downloaded" && net.changed) saveNote = "last-seen.json은 그대로입니다(확인 후 --save 로 갱신).";

  const cacheInfo = { rawSha: sha256File(paths.raw), prevSha: sha256File(paths.prev), hasPrev: parity.hasPrev, sameAsPrev: parity.sameAsPrev };
  out(buildReport({ nowMs, net, patch, parity, cls, known, exitCode, saveNote, cacheInfo }));
  return exitCode;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error("update-site 오류:", e && e.stack || e); process.exitCode = 3; });
}
module.exports = { main, networkPhase, classify, parseParity, buildReport, defaultPaths, TESTS };
