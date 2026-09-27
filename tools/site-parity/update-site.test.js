// Unit-style tests for the network safety of update-site.js / net-guard.js. No real network: a fake fetch is injected.
// Run: node tools/site-parity/update-site.test.js
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path");
const guard = require("./net-guard");
const US = require("./update-site");

let failed = 0;
async function test(name, fn) { try { await fn(); console.log("PASS", name); } catch (e) { failed++; console.log("FAIL", name, "\n  ", e && e.stack || e); } }

const respond = (body, status = 200, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, arrayBuffer: async () => { const b = Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } });
const INDEX = '<html><script src="/assets/main-TESTAAAA.js"></script></html>';
const WORKER = "(() => { function generateActions(){} })();\n";
const MAIN = 'var UPDATE_LOG_VERSION="2099-01-01-test";';
function fakeSite() { // counts every call; serves the three site URLs
  const f = { calls: [], headers: [] };
  f.fetch = async (url, opts) => {
    f.calls.push(url); f.headers.push(opts.headers);
    if (url.endsWith("/")) return respond(INDEX);
    if (url.endsWith("/assets/aiWorker.js")) return respond(WORKER);
    if (url.endsWith("/assets/main-TESTAAAA.js")) return respond(MAIN);
    return respond("nope", 404);
  };
  return f;
}
function tmpPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-site-test-"));
  const p = US.defaultPaths(path.join(dir, ".cache")); p.seenFile = path.join(dir, "last-seen.json");
  fs.mkdirSync(p.cacheDir, { recursive: true });
  return p;
}
const H = 3600 * 1000;
const okSteps = () => { const s = { patchCalls: 0, parityCalls: 0 }; s.patchLayer = async () => { s.patchCalls++; return { ok: true, applied: [7, 7] }; }; s.parityLayer = async () => { s.parityCalls++; return { results: US.TESTS.map((t) => ({ test: t, new: { total: 0, byKey: {}, errors: 0 }, old: null })), hasPrev: false, sameAsPrev: false }; }; return s; };
function deps(paths, site, nowMs, steps, out = []) {
  return { paths, now: () => nowMs, createNet: () => guard.createNet({ fetchImpl: site.fetch, lockFile: paths.lockFile, now: () => nowMs }), steps, out: (s) => out.push(s), knownFile: path.join(__dirname, "known-mismatches.json"), _out: out };
}

(async () => {
  await test("request cap: the 6th request throws and is never sent", async () => {
    const site = fakeSite(); const net = guard.createNet({ fetchImpl: site.fetch, recordLock: false });
    for (let i = 0; i < 5; i++) await net.get("https://augmentchess.org/");
    assert.strictEqual(site.calls.length, 5);
    await assert.rejects(() => net.get("https://augmentchess.org/"), (e) => e instanceof guard.RequestCapError && /cap/.test(e.message));
    assert.strictEqual(site.calls.length, 5, "6th request must not reach fetch");
    assert.strictEqual(net.count(), 5);
  });

  await test("every request carries the identifying User-Agent; a redirect hop counts as a request", async () => {
    const calls = []; const fetchImpl = async (url, opts) => { calls.push([url, opts.headers["User-Agent"], opts.redirect]); return calls.length === 1 ? respond("", 302, { location: "/final" }) : respond("ok"); };
    const net = guard.createNet({ fetchImpl, recordLock: false });
    const body = await net.get("https://augmentchess.org/start");
    assert.strictEqual(body.toString(), "ok"); assert.strictEqual(net.count(), 2);
    assert.deepStrictEqual(calls.map((c) => c[0]), ["https://augmentchess.org/start", "https://augmentchess.org/final"]);
    assert(calls.every((c) => c[1] === guard.USER_AGENT && c[2] === "manual"));
    assert(/TwistParityCheck/.test(guard.USER_AGENT));
  });

  await test("redirect loop is not followed (second redirect => error, 2 requests)", async () => {
    const fetchImpl = async () => respond("", 302, { location: "/again" });
    const net = guard.createNet({ fetchImpl, recordLock: false });
    await assert.rejects(() => net.get("https://augmentchess.org/a"), /second redirect/);
    assert.strictEqual(net.count(), 2);
  });

  await test("lock: a second run within 6h makes no network request and uses the cache; after 6h or --force-network it may fetch", async () => {
    const paths = tmpPaths(), site = fakeSite(), t0 = Date.parse("2099-01-01T00:00:00Z");
    // run 1: fresh site, downloads 3 files, --save writes last-seen
    const s1 = okSteps(); const d1 = deps(paths, site, t0, s1);
    assert.strictEqual(await US.main(["--save"], d1), 0);
    assert.strictEqual(site.calls.length, 3, "index + worker + main bundle");
    assert(fs.existsSync(paths.lockFile) && fs.existsSync(paths.real) && fs.existsSync(paths.seenFile));
    // run 2, 1h later: blocked
    let createNetCalls = 0; const s2 = okSteps(); const d2 = deps(paths, site, t0 + 1 * H, s2); const base = d2.createNet; d2.createNet = () => { createNetCalls++; return base(); };
    assert.strictEqual(await US.main([], d2), 0);
    assert.strictEqual(site.calls.length, 3, "no request within 6h"); assert.strictEqual(createNetCalls, 0);
    assert(/요청 안 함/.test(d2._out.join("\n")), "report must say it used the cache");
    assert.strictEqual(s2.patchCalls, 1, "local steps still run on cached files");
    // run 3, 5h59m later: still blocked
    assert.strictEqual(await US.main([], deps(paths, site, t0 + 6 * H - 60000, okSteps())), 0);
    assert.strictEqual(site.calls.length, 3);
    // run 4, --force-network within the window: allowed, bundle unchanged + force => downloads all 3 again
    const d4 = deps(paths, site, t0 + 2 * H, okSteps());
    assert.strictEqual(await US.main(["--force-network"], d4), 0);
    assert.strictEqual(site.calls.length, 6);
    // run 5, 7h after the LAST request (lock moved to t0+2h): cheap detection => 1 request (main page only), bundle unchanged
    const d5 = deps(paths, site, t0 + 2 * H + 7 * H, okSteps());
    assert.strictEqual(await US.main([], d5), 0);
    assert.strictEqual(site.calls.length, 7, "cheap check = main page only");
    assert(/워커는 받지 않음/.test(d5._out.join("\n")));
  });

  await test("bootstrap: no lock file but a recent last-seen.json checkedAt still blocks the network", async () => {
    const paths = tmpPaths(), site = fakeSite(), t0 = Date.parse("2099-01-01T12:00:00Z");
    fs.writeFileSync(paths.seenFile, JSON.stringify({ mainBundle: "main-TESTAAAA.js", aiWorkerSha256: "x", checkedAt: new Date(t0 - 30 * 60000).toISOString() }));
    fs.writeFileSync(paths.real, "module.exports={}");
    assert.strictEqual(await US.main([], deps(paths, site, t0, okSteps())), 0);
    assert.strictEqual(site.calls.length, 0);
  });

  await test("network error: no retry, stops before local steps, exit code 3; rerun within 6h stays offline", async () => {
    const paths = tmpPaths(), t0 = Date.parse("2099-01-01T00:00:00Z"); let calls = 0;
    const site = { fetch: async () => { calls++; throw new Error("ECONNRESET (fake)"); } };
    const steps = okSteps(); const d = deps(paths, site, t0, steps);
    assert.strictEqual(await US.main([], d), 3);
    assert.strictEqual(calls, 1, "exactly one attempt, no retry");
    assert.strictEqual(steps.patchCalls + steps.parityCalls, 0);
    assert(/네트워크 오류로 중단/.test(d._out.join("\n")));
    assert(fs.existsSync(paths.lockFile), "the failed attempt still arms the lock");
    assert.strictEqual(await US.main([], deps(paths, site, t0 + H, okSteps())), 3);
    assert.strictEqual(calls, 1, "lock blocks the next run");
  });

  await test("HTTP 503 is also a stop, not a retry", async () => {
    const paths = tmpPaths(); let calls = 0;
    const site = { fetch: async () => { calls++; return respond("busy", 503); } };
    assert.strictEqual(await US.main([], deps(paths, site, Date.parse("2099-01-01T00:00:00Z"), okSteps())), 3);
    assert.strictEqual(calls, 1);
  });

  await test("classify: unlisted and increased are flagged, known ones are not", async () => {
    const known = { regressionSlack: { min: 3, ratio: 0.5 }, known: { recurrence: "x", move: "y" } };
    const t = { id: "actions" };
    const r = [{ test: t, new: { total: 0, byKey: { recurrence: 13, move: 4, newcard: 2, other: 1 }, errors: 0 }, old: { byKey: { recurrence: 13, move: 0, other: 1 } } }];
    const c = US.classify(r, known);
    assert.deepStrictEqual(c.keys.sort(), ["move", "newcard", "other"]);
    assert.strictEqual(c.flags.find((f) => f.key === "move").kind, "increased");
    assert.strictEqual(c.flags.find((f) => f.key === "newcard").kind, "unlisted");
  });

  await test("parseParity reads the three script summaries", async () => {
    assert.deepStrictEqual(US.parseParity("actions", 'compared=400 errors=0 differing=5 (1.3%) sides={"E":5} byAction={"card:recurrence":13}\n').byKey, { recurrence: 13 });
    assert.deepStrictEqual(US.parseParity("apply", 'applied=290 notInEngineList=3 errors=1 differing=7 byAction={"zugzwang":1,"move":2}\n').byKey, { zugzwang: 1, move: 2 });
    const p = US.parseParity("playout", 'games=100 plies=900 (card plies=200) diverged=5 byCause={"actions-differ after move:":1,"state-differs after move":1,"state-differs after symmetry":1,"actions-differ after card:locustSwarm":1,"actions-differ after start":1}\n');
    assert.deepStrictEqual(p.byKey, { move: 2, symmetry: 1, locustSwarm: 1, start: 1 }); assert.strictEqual(p.total, 5);
  });

  console.log(failed ? `\n${failed} test(s) FAILED` : "\nall tests passed");
  process.exitCode = failed ? 1 : 0;
})();
