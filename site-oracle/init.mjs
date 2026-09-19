// Minimal browser-global shims so the site's bundle can load in Node.
// Goal: let top-level module code execute without crashing; we don't need
// real DOM behavior, just enough surface that property reads/calls don't throw.
function noop() {}
function stubEl() {
  return new Proxy({}, {
    get(target, prop) {
      if (prop === "style") return new Proxy({ setProperty: noop, removeProperty: noop, getPropertyValue: () => "" }, { get: (t, p) => (p in t ? t[p] : ""), set: () => true });
      if (prop === "classList") return { add: noop, remove: noop, toggle: noop, contains: () => false };
      if (prop === "addEventListener" || prop === "removeEventListener") return noop;
      if (prop === "parentElement" || prop === "parentNode" || prop === "firstElementChild" || prop === "lastElementChild") return stubEl();
      if (prop === "children" || prop === "childNodes") return [];
      if (prop === "querySelector") return () => stubEl();
      if (prop === "querySelectorAll") return () => [];
      if (prop === "appendChild" || prop === "removeChild" || prop === "setAttribute" || prop === "getAttribute") return noop;
      if (typeof prop === "symbol") return undefined;
      return noop;
    },
    set() { return true; }
  });
}

globalThis.self = globalThis;
globalThis.window = globalThis;
if (typeof globalThis.addEventListener !== "function") {
  const listeners = new Map();
  globalThis.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  };
  globalThis.removeEventListener = (type, fn) => listeners.get(type)?.delete(fn);
  globalThis.dispatchEvent = (evt) => { (listeners.get(evt?.type) || []).forEach((fn) => fn(evt)); return true; };
}
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "node", language: "en", languages: ["en"], clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true
});
globalThis.document = new Proxy({
  documentElement: stubEl(),
  body: stubEl(),
  readyState: "complete"
}, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (prop === "createElement") return () => stubEl();
    if (prop === "getElementById" || prop === "querySelector") return () => stubEl();
    if (prop === "querySelectorAll") return () => [];
    if (prop === "addEventListener" || prop === "removeEventListener") return noop;
    if (prop === "createEvent") return () => ({ initEvent: noop });
    if (typeof prop === "symbol") return undefined;
    return noop;
  }
});
globalThis.localStorage = (() => {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear()
  };
})();
globalThis.sessionStorage = globalThis.localStorage;
globalThis.location = { href: "https://augmentchess.org/", origin: "https://augmentchess.org", search: "", pathname: "/", hostname: "augmentchess.org" };
globalThis.history = { pushState: noop, replaceState: noop, back: noop };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.matchMedia = () => ({ matches: false, addListener: noop, removeListener: noop, addEventListener: noop, removeEventListener: noop });
globalThis.CustomEvent = class CustomEvent { constructor(type, opts) { this.type = type; Object.assign(this, opts); } };
globalThis.Event = globalThis.CustomEvent;
globalThis.WebSocket = class WebSocket { constructor() {} send() {} close() {} addEventListener() {} };
globalThis.Worker = class Worker { constructor() {} postMessage() {} terminate() {} addEventListener() {} };
globalThis.fetch = globalThis.fetch || (async () => ({ ok: false, json: async () => ({}), text: async () => "" }));
globalThis.Image = class Image { constructor() {} set src(v) {} addEventListener() {} };
globalThis.HTMLCanvasElement = class HTMLCanvasElement {};
for (const name of ["Node", "Element", "HTMLElement", "SVGElement", "HTMLInputElement", "HTMLButtonElement", "HTMLSelectElement"]) {
  if (!globalThis[name]) globalThis[name] = class {};
}
globalThis.MutationObserver = class MutationObserver { constructor() {} observe() {} disconnect() {} };
globalThis.ResizeObserver = class ResizeObserver { constructor() {} observe() {} disconnect() {} };
globalThis.IntersectionObserver = class IntersectionObserver { constructor() {} observe() {} disconnect() {} };
// Stray setTimeout/UI callbacks from the real boot sequence (e.g.
// positionEditorUndoButton) can fire after import resolves and crash the
// process -- we only care about pure game-logic functions, so swallow these.
process.on("uncaughtException", (err) => {
  console.error("[init] swallowed stray async error:", err?.message);
});
process.on("unhandledRejection", (err) => {
  console.error("[init] swallowed stray rejection:", err?.message);
});
console.error("[init] browser-global shims installed");
