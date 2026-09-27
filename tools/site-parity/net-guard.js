// Shared network guard for the site-parity tools (check-site-update.js, fetch-real-worker.js, update-site.js).
// Everything that touches https://augmentchess.org goes through createNet(), which enforces:
//   - a hard per-run request cap (default 5; the 6th request THROWS before anything is sent),
//   - an identifying User-Agent,
//   - a timeout on every request,
//   - redirects are followed by hand so every hop counts as a request,
//   - no retries anywhere (an error is thrown to the caller, who must stop and report),
//   - a "last network use" timestamp in .cache/network-lock.json (written BEFORE each request, so failures count too).
// The 6-hour minimum interval is enforced by update-site.js via lockStatus(); the standalone scripts only record it.
const fs = require("fs"), path = require("path");

const USER_AGENT = "TwistParityCheck (personal research; contact via GitHub Vamp-pire)";
const MAX_REQUESTS = 5;
const MIN_INTERVAL_HOURS = 6;
const TIMEOUT_MS = 60000;
const CACHE_DIR = path.join(__dirname, ".cache");
const LOCK_FILE = path.join(CACHE_DIR, "network-lock.json");

class RequestCapError extends Error {}

function readLock(lockFile = LOCK_FILE) {
  try { const j = JSON.parse(fs.readFileSync(lockFile, "utf8")); return Number.isFinite(j.lastNetworkAtMs) ? j : null; } catch { return null; }
}
function writeLock(lockFile, nowMs, requestsThisRun) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ lastNetworkAtMs: nowMs, lastNetworkAtIso: new Date(nowMs).toISOString(), requestsThisRun }, null, 2) + "\n");
}
// { blocked, lastMs, ageMs, source }. `fallbackMs` (optional) is used only when the lock file does not exist yet
// (bootstrap from older artifacts such as last-seen.json's checkedAt).
function lockStatus({ lockFile = LOCK_FILE, nowMs = Date.now(), minHours = MIN_INTERVAL_HOURS, fallbackMs = null } = {}) {
  const lock = readLock(lockFile);
  const lastMs = lock ? lock.lastNetworkAtMs : (Number.isFinite(fallbackMs) ? fallbackMs : null);
  if (lastMs == null) return { blocked: false, lastMs: null, ageMs: null, source: "none" };
  const ageMs = nowMs - lastMs;
  return { blocked: ageMs < minHours * 3600 * 1000, lastMs, ageMs, source: lock ? "lock-file" : "fallback" };
}

function createNet({ fetchImpl = globalThis.fetch, maxRequests = MAX_REQUESTS, userAgent = USER_AGENT, lockFile = LOCK_FILE, recordLock = true, now = Date.now, timeoutMs = TIMEOUT_MS } = {}) {
  let count = 0;
  const log = [];
  async function request(url) { // one counted request; returns the raw Response (redirects NOT followed)
    if (count >= maxRequests) throw new RequestCapError(`request cap exceeded: ${maxRequests} requests per run (refusing ${url})`);
    count += 1;
    log.push(url);
    if (recordLock) { try { writeLock(lockFile, now(), count); } catch {} }
    return fetchImpl(url, { redirect: "manual", headers: { "User-Agent": userAgent }, signal: AbortSignal.timeout(timeoutMs) });
  }
  const isRedirect = (res) => res.status >= 300 && res.status < 400 && Boolean(res.headers?.get?.("location"));
  async function get(url) { // -> Buffer; throws on HTTP errors, network errors, cap. No loop, no retry: at most ONE redirect is followed (straight-line, counted).
    let cur = url;
    let res = await request(cur);
    if (isRedirect(res)) {
      cur = new URL(res.headers.get("location"), cur).href;
      res = await request(cur);
      if (isRedirect(res)) throw new Error(cur + " -> second redirect (" + res.status + "); not followed");
    }
    if (!res.ok) throw new Error(cur + " -> HTTP " + res.status);
    return Buffer.from(await res.arrayBuffer());
  }
  return { get, count: () => count, urls: () => log.slice(), maxRequests };
}

let defaultNet = null;
const getDefaultNet = () => defaultNet || (defaultNet = createNet());

module.exports = { createNet, getDefaultNet, lockStatus, readLock, writeLock, RequestCapError, USER_AGENT, MAX_REQUESTS, MIN_INTERVAL_HOURS, LOCK_FILE, CACHE_DIR };
