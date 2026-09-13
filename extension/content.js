(function () {
  "use strict";

  // Version marker so a stale-cached content script is trivially provable/
  // disprovable from the console instead of guessed at -- bump the string
  // whenever this file changes in a way worth confirming actually reloaded.
  console.log("[증강체스엔진] content.js loaded, build 2026-09-12-a (MAIN world + ext-bridge)");

  // chrome.runtime is unavailable here now that this file runs in the page's
  // MAIN world (needed so window.Worker/window.AugmentEngine etc. are
  // actually visible to/shared with the page and each other -- see
  // ext-bridge.js's comment for the full story). ext-bridge.js (an ISOLATED-
  // world script that still runs first, at document_start) stashes the
  // extension's base URL on the DOM instead, which IS shared across worlds.
  const ICON_BASE = (document.documentElement.dataset.augExtBase || "") + "icons/";

  // ---- Settings (persisted in localStorage) ----
  // Stockfish instance count: more instances = more real memory (~7MB WASM
  // module each) but lets that many stockfish-side lines get judged at once
  // instead of queueing behind one instance -- a real tradeoff, so it's a
  // user choice, not a fixed default.
  //
  // Review concurrency: how many plies get classified at once. Defaults to
  // "auto" (analysis.js picks a value from the device's core count), but a
  // user on a known-strong or known-weak machine can override it directly.
  const SETTINGS_KEYS = {
    stockfishInstances: "augEngineStockfishInstances",
    reviewConcurrency: "augEngineReviewConcurrency", // "auto" or "1".."4"
    // Live-play Stockfish tuning (2026-09-13): previously hardcoded to depth
    // 16 / no time cap inside ai-override.js -- exposed here instead so the
    // player can trade off strength vs. speed themselves, now that the
    // hybrid Stockfish path is confirmed actually working end to end (see
    // this session's isolated/main-world + iframe-in-body + load-based-
    // readiness fixes). ai-override.js reads these same keys directly via
    // localStorage (it can't call these getters -- different file/closure).
    liveStockfishDepth: "augEngineLiveStockfishDepth",
    liveStockfishThinkTimeMs: "augEngineLiveStockfishThinkTimeMs"
  };

  function getStoredInstanceCount() {
    const raw = Number(localStorage.getItem(SETTINGS_KEYS.stockfishInstances));
    return raw >= 1 && raw <= 4 ? raw : 1;
  }

  function applyInstanceCount(n) {
    localStorage.setItem(SETTINGS_KEYS.stockfishInstances, String(n));
    window.__augStockfish?.setInstanceCount(n);
  }

  function getStoredLiveDepth() {
    const raw = Number(localStorage.getItem(SETTINGS_KEYS.liveStockfishDepth));
    return raw >= 4 && raw <= 24 ? raw : 16;
  }

  function getStoredLiveThinkTimeMs() {
    const raw = Number(localStorage.getItem(SETTINGS_KEYS.liveStockfishThinkTimeMs));
    return raw > 0 && raw <= 30000 ? raw : 0; // 0 = no cap, depth alone decides
  }

  function getStoredReviewConcurrency() {
    const raw = localStorage.getItem(SETTINGS_KEYS.reviewConcurrency);
    return raw && raw !== "auto" && Number(raw) >= 1 && Number(raw) <= 4 ? Number(raw) : "auto";
  }

  function applyReviewConcurrency(value) {
    localStorage.setItem(SETTINGS_KEYS.reviewConcurrency, String(value));
    window.__augEngineAnalysis?.setReviewConcurrency(value === "auto" ? null : Number(value));
  }

  applyInstanceCount(getStoredInstanceCount());
  applyReviewConcurrency(getStoredReviewConcurrency());

  // ---- Floating board-bottom button: one button, three states depending on
  // this specific board's game state (works on any tab that renders a board
  // -- an active game, the board editor, an idle pre-game board, etc). This
  // is a deliberate anti-cheat gate -- recommending moves while a game is
  // still in progress would let someone use it as a live assistant, so the
  // button hides itself entirely whenever a game is actually in progress on
  // that board, and everything it opens only ever looks at a position that's
  // already decided (a finished game just played, or one loaded in from an
  // .acg file).
  //
  // #newGameButton keeps the same element/id across states and just changes
  // its label: "기권" while a game is in progress, something containing
  // "종료" once it's over, anything else (usually "새 게임", or the button
  // not existing at all, e.g. on the board editor) when there's no active
  // game on this board.

  // Found live (2026-09-12): a game started from the board editor's "AI와
  // 플레이" flow never shows "기권" on #newGameButton -- it read "돌아가기"
  // (and "END" was seen in an earlier check of the same flow) while the game
  // was actively in progress, meaning this fell through to "idle" and the
  // anti-cheat gate above didn't fire -- the review button/tool showed up
  // DURING a live board-editor game. `body.game-started` (confirmed present
  // in that same flow, absent on the pre-game mode-select screen) is used as
  // a second, broader in-progress signal so this can't happen for whatever
  // other label variants exist on paths not audited yet. Deliberately
  // conservative in the anti-cheat direction: if it turns out game-started
  // never gets removed after a board-editor game ends, the cost is the
  // review button staying unavailable there (an inconvenience) -- not the
  // security hole this gate exists to prevent. Revisit if that turns out to
  // be the case.
  function boardGameState() {
    const hasBoard = document.querySelectorAll("button.square").length === 64;
    if (!hasBoard) return "no-board";
    const label = (document.querySelector("#newGameButton")?.textContent || "").trim();
    if (/종료/.test(label)) return "over";
    if (label === "기권" || document.body.classList.contains("game-started")) return "in-progress";
    return "idle";
  }

  // The site already has its own .acg import pipeline wired to a hidden
  // #acgFileInput (its own parser -- versioned format with a trailing
  // SHA-256 integrity check, not something to reimplement here). Feeding it
  // a dropped file through that same input reuses the site's own loader, and
  // afterwards the site reports the loaded record exactly like a
  // just-finished game (#newGameButton flips to "게임 종료", the notation
  // panel fills in), so the existing finished-game review path just works.
  async function loadAcgFileIntoSite(file) {
    const input = document.querySelector("#acgFileInput");
    if (!input) {
      showMessage("기보로 게임 리뷰", "이 사이트에서 .acg 불러오기 기능을 찾지 못했습니다.");
      return false;
    }
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (document.body.classList.contains("acg-viewer") || boardGameState() === "over") return true;
    }
    showMessage("기보로 게임 리뷰", "파일을 불러오지 못했습니다. .acg 파일이 맞는지 확인해주세요.");
    return false;
  }

  async function handleAcgDrop(file) {
    if (!file || !/\.acg$/i.test(file.name)) {
      showMessage("기보로 게임 리뷰", ".acg 파일만 놓을 수 있습니다.");
      return;
    }
    const loaded = await loadAcgFileIntoSite(file);
    if (loaded) openReviewPanel();
  }

  // Recomputes and (only if changed) applies this button's grid placement
  // and width under the board. Pulled out of ensureReviewButton and called
  // on EVERY invocation, not just at creation -- found live (2026-09-08)
  // that computing this once at creation goes stale: .notation-panel can
  // switch between a collapsed and "expanded" state (extra class, same grid
  // row) after the button already exists, and a row number computed before
  // that expansion no longer reflects reality, landing the button right on
  // top of the now-taller notation panel. Only writes style properties
  // (never re-appends an already-attached btn), so this can safely run
  // every time without tripping the childList MutationObserver below.
  // childList mutations on document.body (see the observer below) aren't
  // reliably enough -- found live (2026-09-09) that a transient post-game
  // result banner briefly occupies a grid row of its own, then removes
  // itself, and the button's position computed while it was still there can
  // end up stuck wrong. Tried a ResizeObserver on .board-layout as a more
  // direct signal (react to the layout's box actually changing, regardless
  // of cause), but confirmed live it never fires here at all despite
  // getBoundingClientRect() clearly showing the height change -- something
  // about this grid container's box model that ResizeObserver isn't
  // picking up. Simple interval-based recheck instead: cheap (a few
  // getComputedStyle reads, only while the button exists) and doesn't
  // depend on guessing which DOM/layout signal will reliably fire.
  let repositionIntervalId = null;
  function ensureRepositionInterval() {
    if (repositionIntervalId) return;
    repositionIntervalId = setInterval(() => {
      const box = document.querySelector(".aug-engine-review-box");
      if (box) repositionReviewButton(box);
    }, 500);
  }

  // Gave up trying to fit into the site's own .board-layout CSS grid
  // (2026-09-09) after chasing it through several distinct shapes -- one
  // row/two columns at some widths, two rows/one column at others, plus
  // grid rows the site reserves for things like a captured-pieces bar that
  // are empty (not display:none, just visually blank) in a given game
  // state but still real, space-taking rows. Every fix for one shape either
  // didn't cover another shape or "correctly" landed the button after a
  // reserved-but-blank row, which still LOOKS like a wrong gap even though
  // the row math was technically right. None of that matters if this
  // doesn't try to be a grid item at all: anchor it with position:fixed
  // directly to .board-frame's own rendered rect (bottom edge, left edge,
  // width), recomputed on the same interval below. This can never care
  // which grid shape is active or what the site reserves space for --
  // "sit right under wherever the board visually is" is exactly what's
  // wanted, and getBoundingClientRect() answers that directly regardless of
  // grid mechanics. Downside: it can overlap whatever the site puts right
  // below the board instead of pushing it down -- acceptable, since "right
  // under the board" was the actual goal, not "wherever the grid's next
  // logical row happens to be".
  function repositionReviewButton(btn) {
    const boardFrame = document.querySelector(".board-frame");
    if (!boardFrame) return false;
    ensureRepositionInterval();
    const rect = boardFrame.getBoundingClientRect();
    // absolute (not fixed): getBoundingClientRect() is viewport-relative, so
    // this adds the page's current scroll offset to convert to document
    // coordinates -- an absolutely positioned element (with no positioned
    // ancestor in between) scrolls with the page like anything else, while
    // "fixed" would stay glued to the viewport and drift off the board the
    // instant the page scrolls, only catching up on the next interval tick.
    const top = rect.bottom + window.scrollY + 8 + "px";
    const left = rect.left + window.scrollX + "px";
    const width = rect.width + "px";
    if (btn.style.position !== "absolute") btn.style.position = "absolute";
    if (btn.style.top !== top) btn.style.top = top;
    if (btn.style.left !== left) btn.style.left = left;
    if (btn.style.width !== width) btn.style.width = width;
    if (btn.style.margin !== "0px") btn.style.margin = "0"; // fixed positioning + a margin fights each other
    if (btn.parentElement !== document.body) document.body.appendChild(btn);
    return true;
  }

  // Two rows (user request 2026-09-09): row 1 is the ORIGINAL single button
  // whose label/behavior changes with game state (게임리뷰: click opens the
  // just-finished game's review, once state is "over" -- 기보리뷰: drag a
  // .acg file onto it any other time) -- that state-dependent behavior
  // itself is unchanged from before, just now sits inside a box instead of
  // standing alone. Row 2 is the review's own NNUE toggle (mirrors
  // ai-override.js's toggle for live bot play, but controls analysis.js's
  // review search instead -- see setUseNnueForReview's comment for why
  // these are two separate toggles).
  const REVIEW_NNUE_KEY = "augEngineReviewUseNnue";
  function ensureReviewButton() {
    const api = window.__augEngineAnalysis;
    // The LOCAL/ONLINE/EDITOR mode-select overlay (the big card grid you see
    // right after opening the site) sits in front of a decorative
    // background board that still has a full 64 squares -- boardGameState()
    // reads that as "idle" same as a real pre-game board, so the button
    // appeared floating over the mode cards (found live 2026-09-09, user
    // screenshot). The site itself marks this with `mode-selecting` on
    // <body> (confirmed live via its own "mode-overlay" element), so that's
    // checked directly rather than trying to teach boardGameState() to
    // somehow distinguish a real idle board from a decorative one behind a
    // modal.
    const modeSelecting = document.body.classList.contains("mode-selecting");
    const state = api ? boardGameState() : "no-board";
    let box = document.querySelector(".aug-engine-review-box");
    if (state === "no-board" || state === "in-progress" || modeSelecting) {
      if (box) box.remove();
      if (repositionIntervalId) { clearInterval(repositionIntervalId); repositionIntervalId = null; }
      return;
    }
    let btn;
    if (box) {
      repositionReviewButton(box);
      btn = box.querySelector(".aug-engine-live-button");
      if (btn.dataset.state === state) return; // nothing changed -- see the childList-mutation-loop note this used to need
    } else {
      box = document.createElement("div");
      box.className = "aug-engine-review-box";

      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "aug-engine-live-button";
      btn.addEventListener("click", () => {
        if (btn.dataset.state === "over") openReviewPanel();
      });
      btn.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.stopPropagation();
        btn.classList.add("aug-engine-drag-over");
      });
      btn.addEventListener("dragleave", () => btn.classList.remove("aug-engine-drag-over"));
      btn.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        btn.classList.remove("aug-engine-drag-over");
        handleAcgDrop(event.dataTransfer?.files?.[0]);
      });

      const nnueToggle = document.createElement("label");
      nnueToggle.className = "aug-engine-review-nnue-toggle";
      const nnueCheckbox = document.createElement("input");
      nnueCheckbox.type = "checkbox";
      nnueCheckbox.checked = localStorage.getItem(REVIEW_NNUE_KEY) === "1";
      nnueCheckbox.addEventListener("change", () => {
        localStorage.setItem(REVIEW_NNUE_KEY, nnueCheckbox.checked ? "1" : "0");
        window.__augEngineAnalysis?.setUseNnueForReview(nnueCheckbox.checked);
      });
      window.__augEngineAnalysis?.setUseNnueForReview(nnueCheckbox.checked);
      const nnueText = document.createElement("span");
      nnueText.textContent = "베타 엔진(NNUE)으로 리뷰";
      nnueToggle.appendChild(nnueCheckbox);
      nnueToggle.appendChild(nnueText);

      box.appendChild(btn);
      box.appendChild(nnueToggle);

      // Anchored right under the board itself -- see repositionReviewButton
      // above for why placement has to be recomputed live rather than fixed
      // once here. Falls back to a plain sibling insertion (or
      // document.body) if the site's markup doesn't match what
      // repositionReviewButton expects, so the box still appears somewhere
      // rather than silently never being created.
      const positioned = repositionReviewButton(box);
      if (!positioned) {
        const boardFrame = document.querySelector(".board-frame");
        if (boardFrame) boardFrame.insertAdjacentElement("afterend", box);
        else document.body.appendChild(box);
      }
    }
    btn.dataset.state = state;
    btn.textContent = state === "over" ? "🔍 게임리뷰" : "📁 기보리뷰 (.acg 파일을 여기 놓으세요)";
  }

  // ---- Overlay/panel plumbing ----
  // Every popup in this extension (plain message boxes and the review panel)
  // shares the same backdrop element and close conventions: click the
  // backdrop or an ".aug-engine-close" button to dismiss, Escape always
  // dismisses whichever one is open. Centralized here so each caller only
  // supplies its own inner markup.

  function createOverlay(innerHtml, panelClass) {
    const overlay = document.createElement("div");
    overlay.className = "aug-engine-overlay";
    overlay.innerHTML = '<div class="aug-engine-panel' + (panelClass ? " " + panelClass : "") + '">' + innerHtml + "</div>";
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
    const panel = overlay.querySelector(".aug-engine-panel");
    wireClose(panel);
    return { overlay, panel };
  }

  function wireClose(panel) {
    panel.querySelector(".aug-engine-close")?.addEventListener("click", () => panel.closest(".aug-engine-overlay")?.remove());
  }

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    document.querySelector(".aug-engine-overlay")?.remove();
  });

  function showMessage(title, text) {
    if (document.querySelector(".aug-engine-overlay")) return;
    createOverlay("<h2>" + title + "</h2><p>" + text + '</p><button type="button" class="aug-engine-close">닫기</button>');
  }

  // ---- Review panel ----

  const REVIEW_CONCURRENCY_OPTIONS = ["auto", 1, 2, 3, 4];

  function settingsRowHtml() {
    const instanceOptions = [1, 2, 3, 4]
      .map((n) => '<option value="' + n + '"' + (n === getStoredInstanceCount() ? " selected" : "") + ">" + n + "</option>")
      .join("");
    const concurrencyOptions = REVIEW_CONCURRENCY_OPTIONS.map((v) => {
      const label = v === "auto" ? "자동(기본)" : String(v);
      return '<option value="' + v + '"' + (v === getStoredReviewConcurrency() ? " selected" : "") + ">" + label + "</option>";
    }).join("");
    return (
      '<label class="aug-engine-settings-row">스톡피시 인스턴스 수 <select class="aug-engine-instance-select">' + instanceOptions + "</select></label>" +
      '<label class="aug-engine-settings-row">동시 처리 수 <select class="aug-engine-concurrency-select">' + concurrencyOptions + "</select></label>" +
      '<label class="aug-engine-settings-row aug-engine-settings-checkbox"><input type="checkbox" class="aug-engine-skip-cache"> 캐시 무시하고 새로 계산</label>' +
      '<p class="aug-engine-hint aug-engine-instance-hint">인스턴스가 많을수록 표준기물 라인을 더 동시에 볼 수 있지만 메모리를 더 씁니다. 동시 처리 수는 기기 성능에 안 맞으면 직접 낮춰보세요.</p>'
    );
  }

  function wireSettingsRow(panel) {
    panel.querySelector(".aug-engine-instance-select").addEventListener("change", (event) => applyInstanceCount(Number(event.target.value)));
    panel.querySelector(".aug-engine-concurrency-select").addEventListener("change", (event) => applyReviewConcurrency(event.target.value));
  }

  async function openReviewPanel() {
    const engine = window.AugmentEngine;
    const api = window.__augEngineAnalysis;
    if (!engine || !api) {
      showMessage("게임 리뷰", "엔진을 불러오지 못했습니다.");
      return;
    }
    if (!api.isGameOver()) {
      showMessage("게임 리뷰", "대국이 끝난 뒤에만 사용할 수 있습니다.");
      return;
    }
    if (document.querySelector(".aug-engine-overlay")) return;

    const { overlay, panel } = createOverlay(
      "<h2>게임 리뷰</h2>" +
        '<p class="aug-engine-hint">얼마나 정밀하게 볼까요?</p>' +
        '<div class="aug-engine-mode-actions">' +
        '<button type="button" class="aug-engine-mode-fast">⚡ 빠른 리뷰</button>' +
        '<button type="button" class="aug-engine-mode-deep">🔬 정밀 리뷰 (느림)</button>' +
        "</div>" +
        settingsRowHtml() +
        '<button type="button" class="aug-engine-close">닫기</button>',
      "aug-engine-review-panel"
    );
    wireSettingsRow(panel);

    let reviewStarted = false;
    async function startReview(mode) {
      if (reviewStarted) return; // ignore a second click while one run is already in flight
      reviewStarted = true;
      const skipCache = panel.querySelector(".aug-engine-skip-cache")?.checked;
      panel.innerHTML =
        "<h2>게임 리뷰</h2>" +
        '<p class="aug-engine-loading">기보를 따라가며 계산 중... (<span class="aug-engine-progress">0 / 0 (0%)</span>)<br>' +
        (mode === "deep" ? "깊이 있게 보느라 수 분 걸릴 수 있어요, 끝난 대국이니 여유롭게 기다려주세요." : "빠른 모드라 대부분 금방 끝나요.") +
        "</p>";
      const progressEl = panel.querySelector(".aug-engine-progress");

      const result = await api.runFullGameReview(
        engine,
        (done, total) => {
          if (progressEl) progressEl.textContent = done + " / " + total + " (" + Math.round((done / total) * 100) + "%)";
        },
        mode,
        skipCache
      );

      if (!result.error) annotateNotationPanel(result.plies);
      if (!document.body.contains(overlay)) return; // panel was closed mid-run
      renderReview(panel, result, true);
    }

    panel.querySelector(".aug-engine-mode-fast").addEventListener("click", () => startReview("fast"));
    panel.querySelector(".aug-engine-mode-deep").addEventListener("click", () => startReview("deep"));
  }

  // Puts a small classification icon directly on each move in the site's own
  // notation panel, so you can click through your own game history (the site
  // already supports that) and see the verdict for each move right where it
  // happened, instead of only in a separate popup list.
  //
  // #notationTableWrap re-renders its DOM whenever you navigate history (e.g.
  // jumping back to the start), which wipes any icons we appended as children
  // -- so this keeps the last review's plies around and re-applies them
  // whenever the panel's DOM changes, not just once right after the review.
  let lastReviewPlies = null;
  let notationObserver = null;

  function addNotationIcon(btn, iconFile, label) {
    if (btn.querySelector(".aug-engine-move-icon")) return; // already there, don't rebuild needlessly
    const icon = document.createElement("img");
    icon.className = "aug-engine-move-icon";
    icon.src = ICON_BASE + iconFile;
    icon.alt = label;
    icon.title = label;
    btn.appendChild(icon);
  }

  function applyNotationIcons(plies) {
    const wrap = document.querySelector("#notationTableWrap");
    if (!wrap || !plies) return;

    const moveButtons = Array.from(wrap.querySelectorAll(".notation-entry.notation-move"));
    moveButtons.forEach((btn, index) => {
      const ply = plies[index];
      if (!ply) return;
      addNotationIcon(btn, ply.classification.icon, ply.classification.label + (ply.loss ? " (손실 " + ply.loss + ")" : ""));
    });

    // Card plays (.notation-gain entries) don't get their own ply in `plies`
    // -- the turn's net eval swing (card effect + whatever move happened
    // alongside it) shows up on the following move's icon instead, since
    // collectMoveHistoryPositions only snapshots after real moves. This is
    // just a marker so the card entry itself doesn't look untouched.
    const cardButtons = Array.from(wrap.querySelectorAll(".notation-entry.notation-gain"));
    cardButtons.forEach((btn) => {
      addNotationIcon(btn, "move_forced.svg", "카드 사용 (평가는 다음 수 아이콘 참고)");
    });
  }

  function annotateNotationPanel(plies) {
    lastReviewPlies = plies;
    applyNotationIcons(plies);

    const wrap = document.querySelector("#notationTableWrap");
    if (!wrap) return;
    if (notationObserver) notationObserver.disconnect();
    notationObserver = new MutationObserver(() => {
      if (!lastReviewPlies) return;
      notationObserver.disconnect();
      applyNotationIcons(lastReviewPlies);
      notationObserver.observe(wrap, { childList: true, subtree: true });
    });
    notationObserver.observe(wrap, { childList: true, subtree: true });
  }

  function accuracyClass(value) {
    if (typeof value !== "number") return "";
    if (value >= 90) return "aug-engine-accuracy-good";
    if (value >= 70) return "aug-engine-accuracy-mid";
    return "aug-engine-accuracy-bad";
  }

  function summarizeCounts(plies) {
    const api = window.__augEngineAnalysis;
    if (!api) return "";
    const counts = {};
    plies.forEach((p) => {
      const id = p.classification.id;
      counts[id] = (counts[id] || 0) + 1;
    });
    return api.CLASSIFICATIONS.filter((c) => counts[c.id])
      .map((c) => c.label + " " + counts[c.id])
      .join(" · ");
  }

  function renderReview(panel, result, showNotationHint) {
    if (!panel) return;
    if (result.error && !result.plies) {
      panel.innerHTML = "<h2>게임 리뷰</h2><p>" + result.error + '</p><button type="button" class="aug-engine-close">닫기</button>';
      wireClose(panel);
      return;
    }

    const rows = result.plies
      .map((p, index) => {
        const moveNo = Math.floor(index / 2) + 1;
        const c = p.classification;
        const label = p.moverColor === "white" ? moveNo + ". " : moveNo + "... ";
        return (
          '<div class="aug-engine-review-row">' +
          '<img src="' + ICON_BASE + c.icon + '" alt="' + c.label + '" width="20" height="20">' +
          '<span class="aug-engine-review-move">' + label + (p.from !== "-" ? p.from + "→" + p.to : "") + "</span>" +
          '<span class="aug-engine-review-tag">' + c.label + "</span>" +
          "</div>"
        );
      })
      .join("");

    const hint = showNotationHint
      ? '<p class="aug-engine-hint">이 창을 닫고 기보를 눌러 넘기면, 각 수 옆에 아이콘이 그대로 붙어있어요.</p>'
      : "";
    const warning = result.warning ? '<p class="aug-engine-warning">' + result.warning + "</p>" : "";
    const summary = summarizeCounts(result.plies);

    panel.innerHTML =
      "<h2>게임 리뷰</h2>" +
      warning +
      '<div class="aug-engine-accuracy">' +
      '<div>백 정확도: <strong class="' + accuracyClass(result.accuracyWhite) + '">' + (result.accuracyWhite ?? "-") + "%</strong></div>" +
      '<div>흑 정확도: <strong class="' + accuracyClass(result.accuracyBlack) + '">' + (result.accuracyBlack ?? "-") + "%</strong></div>" +
      "</div>" +
      (summary ? '<p class="aug-engine-summary">' + summary + "</p>" : "") +
      hint +
      '<div class="aug-engine-review-list">' + rows + "</div>" +
      '<button type="button" class="aug-engine-close">닫기</button>';
    wireClose(panel);
  }

  // ---- AI-opponent override toggle ----
  // Controls ai-override.js (a separate document_start content script --
  // see its own top comment for why it has to be separate/earlier) via the
  // same localStorage key it reads live on every AI move request, so
  // flipping this takes effect on the very next move with no reload
  // needed.
  //
  // Placement history (user feedback, 2026-09-09): first tried floating
  // below the "AI와 플레이" card itself (position:absolute anchored to the
  // card's rect) -- landed on top of the WHITE/BLACK color-choice row
  // (.ai-color-choice) that appears once the card is selected. Then tried
  // appending inside the card -- user wanted it below the "강화" button and
  // WHITE/BLACK row instead, not inside the card at all. Both the enhance
  // button (.ai-enhance-button) and the color choice (.ai-color-choice)
  // live inside one shared flex container, .ai-setup-stack -- anchoring to
  // THAT container's own rect (not either child individually) means it
  // stays correctly below both regardless of which one is taller.
  // Fallback anchor (added after finding a real gap): the setup screen this
  // toggle normally anchors to (.ai-setup-stack) never appears when an AI
  // game is started from the board editor's "AI와 플레이" modal -- that flow
  // skips straight to a game-started board (confirmed live: body carries
  // ai-single-mode/game-started but no .ai-setup-stack anywhere on the
  // page). section.match-players (the AI/GUEST player-card row above the
  // board) exists in that flow and in every other started AI game too, so
  // it doubles as a way to keep the toggle available DURING a game as well,
  // not just before one starts -- useful since ai-override.js already
  // re-reads this key live on every move, not just at game start. Gated on
  // ai-single-mode so this doesn't add the toggle to a plain 2-player local
  // or online game, which also has .match-players but no AI to replace.
  const AI_OVERRIDE_KEY = "augEngineReplaceAI";
  function ensureAiOverrideToggle() {
    const setupStack = document.querySelector(".ai-setup-stack");
    const midGameAnchor = !setupStack && document.body.classList.contains("ai-single-mode")
      ? document.querySelector(".match-players")
      : null;
    const stack = setupStack || midGameAnchor;
    let toggle = document.querySelector(".aug-engine-ai-toggle");
    if (!stack) {
      if (toggle) toggle.remove();
      return;
    }
    if (!toggle) {
      // A plain <div> wrapper (not itself a <label>) so the settings
      // controls below the checkbox row can be clicked/typed into without
      // accidentally toggling the checkbox -- a <label> forwards ANY click
      // inside it to its associated control by default.
      toggle = document.createElement("div");
      toggle.className = "aug-engine-ai-toggle";
      const row = document.createElement("label");
      row.className = "aug-engine-ai-toggle-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.addEventListener("change", () => {
        localStorage.setItem(AI_OVERRIDE_KEY, checkbox.checked ? "1" : "0");
      });
      const text = document.createElement("span");
      text.textContent = "베타 엔진(NNUE)으로 교체";
      row.appendChild(checkbox);
      row.appendChild(text);
      toggle.appendChild(row);

      // Live-play Stockfish tuning (2026-09-13): depth/think-time/instance
      // count were previously hardcoded (depth 16, no time cap) inside
      // ai-override.js -- exposed here now that the hybrid Stockfish path is
      // confirmed working end to end this session. ai-override.js re-reads
      // these localStorage keys on every move, so changes apply to the very
      // next move with no reload needed.
      //
      // Collapsed by default behind a <details> (2026-09-13): the toggle box
      // was covering too much of the board with all three settings always
      // visible -- <details>/<summary> gets expand/collapse for free with no
      // extra JS wiring, and its open state persists in the DOM across the
      // MutationObserver's frequent ensureAiOverrideToggle() reruns as long
      // as this element itself isn't recreated (it's only built once, inside
      // this `if (!toggle)` block).
      const settings = document.createElement("details");
      settings.className = "aug-engine-live-settings";
      settings.innerHTML =
        '<summary>세부 설정</summary>' +
        '<label class="aug-engine-settings-row">스톡피시 탐색 깊이 <input type="number" class="aug-engine-live-depth" min="4" max="24" step="1"></label>' +
        '<p class="aug-engine-hint">숫자가 클수록 더 강해지지만 한 수 두는 데 더 오래 걸립니다. 기본값 16.</p>' +
        '<label class="aug-engine-settings-row">생각 시간 제한 (ms, 0=제한없음) <input type="number" class="aug-engine-live-thinktime" min="0" max="30000" step="500"></label>' +
        '<p class="aug-engine-hint">지정한 시간 안에 탐색 깊이에 못 미치면 그때까지 찾은 최선수를 씁니다. 0이면 시간 제한 없이 깊이까지 다 계산합니다.</p>' +
        '<label class="aug-engine-settings-row">스톡피시 인스턴스 수 <select class="aug-engine-live-instance-select"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label>' +
        '<p class="aug-engine-hint">인스턴스가 많을수록 메모리를 더 쓰지만(인스턴스당 약 7MB) 여러 계산을 동시에 처리할 수 있습니다.</p>';
      toggle.appendChild(settings);
      document.body.appendChild(toggle);

      settings.querySelector(".aug-engine-live-depth").addEventListener("change", (event) => {
        const v = Math.max(4, Math.min(24, Number(event.target.value) || 16));
        localStorage.setItem(SETTINGS_KEYS.liveStockfishDepth, String(v));
        event.target.value = v;
      });
      settings.querySelector(".aug-engine-live-thinktime").addEventListener("change", (event) => {
        const v = Math.max(0, Math.min(30000, Number(event.target.value) || 0));
        localStorage.setItem(SETTINGS_KEYS.liveStockfishThinkTimeMs, String(v));
        event.target.value = v;
      });
      settings.querySelector(".aug-engine-live-instance-select").addEventListener("change", (event) => applyInstanceCount(Number(event.target.value)));
    }
    const checkbox = toggle.querySelector("input[type=checkbox]");
    checkbox.checked = localStorage.getItem(AI_OVERRIDE_KEY) === "1";
    // Don't stomp a value the player is actively editing -- this whole
    // function reruns on every DOM mutation (see the MutationObserver
    // below), which would otherwise fight typing in these inputs.
    const depthInput = toggle.querySelector(".aug-engine-live-depth");
    if (document.activeElement !== depthInput) depthInput.value = getStoredLiveDepth();
    const thinkTimeInput = toggle.querySelector(".aug-engine-live-thinktime");
    if (document.activeElement !== thinkTimeInput) thinkTimeInput.value = getStoredLiveThinkTimeMs();
    const instanceSelect = toggle.querySelector(".aug-engine-live-instance-select");
    if (document.activeElement !== instanceSelect) instanceSelect.value = String(getStoredInstanceCount());

    if (midGameAnchor) {
      // Found live (2026-09-12): unlike .ai-setup-stack's pre-game screen
      // (which has open space below it), .match-players sits flush against
      // the board's top edge with no gap -- anchoring directly below IT
      // just overlapped the board's top ranks. Originally "fixed"-positioned
      // to a screen corner to sidestep that, but that covers part of the
      // screen no matter what's actually on it -- switched (2026-09-13) to
      // the SAME .board-frame anchor repositionReviewButton already uses
      // (see its comment above): "sit right under wherever the board
      // visually is" via absolute positioning off its real rect, not a
      // fixed viewport corner. No overlap with the review button, which is
      // hidden for the whole time this mid-game anchor case applies (the
      // anti-cheat gate hides it during any in-progress game).
      const boardFrame = document.querySelector(".board-frame");
      if (boardFrame) {
        toggle.classList.remove("aug-engine-ai-toggle-corner");
        const frameRect = boardFrame.getBoundingClientRect();
        const top = frameRect.bottom + window.scrollY + 8 + "px";
        const left = frameRect.left + window.scrollX + "px";
        const width = frameRect.width + "px";
        if (toggle.style.position !== "absolute") toggle.style.position = "absolute";
        if (toggle.style.top !== top) toggle.style.top = top;
        if (toggle.style.left !== left) toggle.style.left = left;
        if (toggle.style.width !== width) toggle.style.width = width;
        return;
      }
      // .board-frame not found (shouldn't normally happen mid-game) -- fall
      // back to the old fixed-corner badge rather than showing nothing.
      toggle.classList.add("aug-engine-ai-toggle-corner");
      if (toggle.style.position !== "fixed") toggle.style.position = "fixed";
      toggle.style.top = "";
      toggle.style.left = "";
      toggle.style.width = "";
      return;
    }
    toggle.classList.remove("aug-engine-ai-toggle-corner");
    const rect = stack.getBoundingClientRect();
    const top = rect.bottom + window.scrollY + 8 + "px";
    const left = rect.left + window.scrollX + "px";
    const width = rect.width + "px";
    if (toggle.style.position !== "absolute") toggle.style.position = "absolute";
    if (toggle.style.top !== top) toggle.style.top = top;
    if (toggle.style.left !== left) toggle.style.left = left;
    if (toggle.style.width !== width) toggle.style.width = width;
  }

  const observer = new MutationObserver(() => {
    ensureReviewButton();
    ensureAiOverrideToggle();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  ensureReviewButton();
  ensureAiOverrideToggle();
})();
