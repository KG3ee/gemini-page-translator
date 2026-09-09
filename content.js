// In-place translator. Injected into every frame on demand by background.js
// (context menu, shortcut, side panel button, or auto mode on a listed site).
//
// Only text near the viewport is sent: each candidate text node's parent is
// watched by an IntersectionObserver with one screen of look-ahead, and nodes
// are queued as their element comes near. Translations stream back over a
// port and are written as they arrive. A MutationObserver picks up text that
// appears or changes later (next lesson in a single-page app, expanded
// sections, live counters). Open shadow roots are walked and observed too.
// Only the top frame shows the pill; frames follow its Show original toggle.
(() => {
  const HOST_ID = "gpt-burmese-host";
  const MARK = "data-gpt-burmese"; // set on the parent of a translated text node
  const IS_TOP = window === window.top;

  if (window.__gptBurmese) {
    window.__gptBurmese.run();
    return;
  }
  // A pill without a live instance = the extension was reloaded; the old
  // script world is gone but its Burmese text (marked parents) stays put.
  document.getElementById(HOST_ID)?.remove();

  const SKIP_SELECTOR = [
    // code and code editors
    "script", "style", "noscript", "template", "code", "pre", "kbd", "samp", "var", "tt",
    ".monaco-editor", ".cm-editor", ".CodeMirror", ".ace_editor", "[role='code']", ".react-code-lines", ".hljs", ".prism-code",
    // form controls and embeds
    "textarea", "input", "select", "option", "svg", "math", "iframe", "object", "canvas", "video", "audio",
    // site chrome the reader is not reading
    "nav", "footer", "[role='navigation']", "[role='contentinfo']", "[role='banner']",
    // hidden, assistive-only, icon fonts (aria-hidden is NOT here: sites mark
    // visible text aria-hidden when a screen-reader copy exists elsewhere, e.g.
    // 16personalities' questions; real invisibility is checked at send time)
    "[hidden]", ".sr-only", ".visually-hidden", ".material-icons", "[class*='material-symbols']",
    // explicit opt-outs
    "[translate='no']", ".notranslate", "[contenteditable='']", "[contenteditable='true']", "[contenteditable='plaintext-only']",
    `#${HOST_ID}`,
  ].join(",");
  const MAX_ITEMS = 60;         // fragments per request (look-ahead batches)
  const MAX_CHARS = 5000;       // characters per request
  const SCREEN_ITEMS = 12;      // a small first request paints the visible text fast
  const SCREEN_CHARS = 1200;
  const CONCURRENCY = 2;
  const LOOKAHEAD = "100% 0px 100% 0px"; // one screen above and below counts as "near"
  const MAX_PAGE_CHARS = 300000; // per document; a runaway page cannot burn quota forever
  const SITE = location.hostname.replace(/^www\./, "");

  const store = new Map();        // Text -> { orig, my }
  const seen = new WeakSet();     // Text nodes already picked up
  const pendingEls = new Map();   // Element -> Set<Text> waiting for the element to come near
  const deferred = new Set();     // near but invisible (opacity 0, visibility hidden); re-checked later
  const observedRoots = new WeakSet(); // shadow roots the MutationObserver already watches
  const queue = [];               // Text nodes near the viewport, waiting to be sent
  const state = {
    showing: "my", active: 0, waiting: 0, translated: 0, cached: 0, sentChars: 0,
    fatal: null, notice: null, retryAt: 0, stopped: false, auto: false, autoNeedsGrant: false,
  };
  const pillPrefs = { corner: "br", collapsed: false }; // remembered across pages
  let host, shadow, pillEl, msgEl, dotEl, toggleBtn, autoBtn, io, mo, observeTimer, observeDeadline = 0, retryTimer;

  // ---- what to translate

  function isTranslatable(value) {
    const core = value.trim();
    if (core.length < 2 || !/[A-Za-z]/.test(core)) return false; // numbers, symbols, already Burmese
    const bare = core.replace(/^[(["'“‘]+/, "").replace(/[.:;,!?)\]"'”’]+$/, "");
    if (!bare) return false;
    // identifier / path / URL-like single tokens: foo.bar, /usr/bin, a=b
    if (!/\s/.test(bare) && /[_/\\.:{}()[\]<>=;@#]/.test(bare)) return false;
    return true;
  }

  // Walks a document or shadow root; descends into open shadow roots it meets.
  function collectFrom(root, out) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT; // prune the subtree
          if (node.shadowRoot) {
            watchRoot(node.shadowRoot);
            collectFrom(node.shadowRoot, out);
          }
          return NodeFilter.FILTER_SKIP;
        }
        const p = node.parentElement;
        if (!p || seen.has(node) || p.hasAttribute(MARK)) return NodeFilter.FILTER_REJECT;
        return isTranslatable(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
  }

  function collect() {
    const out = [];
    if (document.body) collectFrom(document.body, out);
    return out;
  }

  function watchRoot(root) {
    if (!mo || observedRoots.has(root)) return;
    observedRoots.add(root);
    mo.observe(root, { childList: true, subtree: true, characterData: true });
  }

  const isVisible = (node) => {
    const el = node.parentElement;
    return !!el && (typeof el.checkVisibility !== "function" || el.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
  };

  // Register new candidates with the IntersectionObserver; prune what left the DOM.
  function observeAll() {
    for (const [el, set] of pendingEls) {
      if (!el.isConnected) {
        io.unobserve(el);
        pendingEls.delete(el);
      }
    }
    for (const [node, rec] of store) {
      if (!node.isConnected) {
        store.delete(node);
        if (rec.my !== rec.orig) state.translated--;
      }
    }
    let added = false;
    for (const node of deferred) {
      if (!node.isConnected || store.has(node)) deferred.delete(node);
      else if (isVisible(node)) {
        deferred.delete(node);
        queue.push(node);
        added = true;
      }
    }
    for (const node of collect()) {
      seen.add(node);
      const el = node.parentElement;
      let set = pendingEls.get(el);
      if (!set) {
        set = new Set();
        pendingEls.set(el, set);
        io.observe(el);
      }
      set.add(node);
    }
    recount();
    if (added) pump();
    else render();
  }

  function recount() {
    let w = 0;
    for (const set of pendingEls.values()) w += set.size;
    state.waiting = w;
  }

  // Debounced, but never starved by a page that mutates continuously.
  function scheduleObserve() {
    const now = Date.now();
    if (!observeDeadline) observeDeadline = now + 1500;
    clearTimeout(observeTimer);
    observeTimer = setTimeout(() => {
      observeDeadline = 0;
      observeAll();
    }, Math.min(300, Math.max(0, observeDeadline - now)));
  }

  function onMutations(records) {
    let structural = false;
    for (const r of records) {
      if (r.type === "characterData") pageChangedText(r.target);
      else structural = true;
    }
    if (structural) scheduleObserve();
  }

  // The page rewrote a text node we translated (live counter, framework
  // re-render): forget our copy and translate the new value.
  function pageChangedText(node) {
    const rec = store.get(node);
    if (!rec || node.nodeValue === rec.my || node.nodeValue === rec.orig) return;
    store.delete(node);
    if (rec.my !== rec.orig) state.translated--;
    seen.delete(node);
    node.parentElement?.removeAttribute(MARK);
    scheduleObserve();
  }

  function onIntersect(entries) {
    let added = false;
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const set = pendingEls.get(en.target);
      io.unobserve(en.target);
      pendingEls.delete(en.target);
      if (!set) continue;
      for (const n of set) {
        if (n.isConnected && !store.has(n)) {
          queue.push(n);
          added = true;
        }
      }
    }
    recount();
    if (added) pump();
  }

  // ---- batching

  function inViewport(node) {
    const r = node.parentElement?.getBoundingClientRect();
    return !!r && r.bottom > 0 && r.top < innerHeight;
  }

  function toEntry(node) {
    const orig = node.nodeValue;
    // leading punctuation (". Just make sure", ", otherwise") is peeled off like
    // whitespace: the model tends to fold it into a separate element
    const m = orig.match(/^(\s*(?:[.,;:!?)\]…]+\s*)?)([\s\S]*?)(\s*)$/);
    const pre = (getComputedStyle(node.parentElement).whiteSpace || "").startsWith("pre");
    const core = pre ? m[2].replace(/[ \t]+/g, " ") : m[2].replace(/\s+/g, " ");
    return { node, orig, lead: m[1], core, trail: m[3] };
  }

  // On-screen text first (small batch, fast first paint), then the look-ahead.
  function takeBatch() {
    const prio = new Map(queue.map((n) => [n, inViewport(n) ? 0 : 1]));
    queue.sort((a, b) => prio.get(a) - prio.get(b));
    const onScreen = queue.length > 0 && prio.get(queue[0]) === 0;
    const maxItems = onScreen ? SCREEN_ITEMS : MAX_ITEMS;
    const maxChars = onScreen ? SCREEN_CHARS : MAX_CHARS;
    const batch = [];
    let chars = 0;
    while (queue.length && batch.length < maxItems) {
      const node = queue[0];
      if (!node.isConnected || store.has(node)) {
        queue.shift();
        continue;
      }
      if (onScreen && batch.length && prio.get(node) !== 0) break; // keep the fast batch on-screen only
      if (!isVisible(node)) {
        queue.shift();
        deferred.add(node);
        continue;
      }
      const e = toEntry(node);
      if (batch.length && chars + e.core.length > maxChars) break;
      queue.shift();
      batch.push(e);
      chars += e.core.length;
    }
    return batch;
  }

  // One port per batch; partial results arrive as the model produces them.
  function request(fragments, onPartial) {
    return new Promise((resolve, reject) => {
      const wrap = (message, retryable, retryAfter = 5000) => Object.assign(new Error(message), { retryable, retryAfter });
      let port;
      try {
        port = chrome.runtime.connect({ name: "translate" });
      } catch (err) {
        const msg = err?.message || String(err);
        return reject(/context invalidated/i.test(msg) ? wrap("The extension was reloaded — run Translate again.", false) : wrap(msg, true));
      }
      let settled = false;
      port.onMessage.addListener((m) => {
        if (m?.type === "partial") onPartial(m.i, m.text);
        else if (m?.type === "done") {
          settled = true;
          resolve(m);
        } else if (m?.type === "error") {
          settled = true;
          reject(wrap(m.error || "Translation failed.", !!m.retryable, m.retryAfter || 5000));
        }
      });
      port.onDisconnect.addListener(() => {
        if (settled) return;
        const msg = chrome.runtime.lastError?.message || "The extension stopped responding.";
        reject(/context invalidated/i.test(msg) ? wrap("The extension was reloaded — run Translate again.", false) : wrap(msg, true));
      });
      port.postMessage({ type: "translate", fragments, title: document.title });
    });
  }

  function writeTranslation(e, t) {
    const rec = { orig: e.orig, my: e.lead + t + e.trail };
    if (!store.has(e.node)) state.translated++;
    store.set(e.node, rec);
    if (state.showing === "my") {
      e.node.nodeValue = rec.my;
      e.node.parentElement?.setAttribute(MARK, "1");
    }
  }

  function revert(entries) {
    for (const e of entries) {
      const rec = store.get(e.node);
      if (!rec) continue;
      store.delete(e.node);
      state.translated--;
      if (e.node.nodeValue === rec.my) e.node.nodeValue = e.orig;
      e.node.parentElement?.removeAttribute(MARK);
    }
  }

  // Length mismatch = the model merged or dropped a fragment; halve twice, then give up on those.
  async function translateBatch(entries, depth = 0) {
    const applied = new Set();
    const apply = (i, text) => {
      const e = entries[i];
      const t = (text || "").trim();
      if (!e || !t) return;
      if (!applied.has(e) && e.node.nodeValue !== e.orig) {
        seen.delete(e.node); // the page changed it meanwhile; collect() will pick it up again
        return;
      }
      writeTranslation(e, t);
      applied.add(e);
    };
    let res;
    try {
      res = await request(entries.map((e) => e.core), apply);
    } catch (err) {
      revert(applied);
      throw err;
    }
    state.cached += res.cached || 0;
    if (res.mismatch) {
      revert(applied);
      if (entries.length > 1 && depth < 2) {
        const mid = Math.ceil(entries.length / 2);
        await Promise.all([translateBatch(entries.slice(0, mid), depth + 1), translateBatch(entries.slice(mid), depth + 1)]);
      } else {
        for (const e of entries) store.set(e.node, { orig: e.orig, my: e.orig }); // stays English, not resent
      }
      return;
    }
    for (const e of entries) if (!applied.has(e) && !store.has(e.node)) store.set(e.node, { orig: e.orig, my: e.orig }); // empty answer: leave it
  }

  function pump() {
    if (state.stopped || state.showing !== "my" || state.fatal || Date.now() < state.retryAt) {
      render();
      return;
    }
    while (state.active < CONCURRENCY && queue.length && state.sentChars < MAX_PAGE_CHARS) {
      const batch = takeBatch();
      if (!batch.length) break;
      const chars = batch.reduce((n, e) => n + e.core.length, 0);
      state.active++;
      state.sentChars += chars;
      translateBatch(batch)
        .catch((err) => {
          queue.unshift(...batch.map((e) => e.node)); // give the text back; nothing is lost
          state.sentChars -= chars;
          if (err?.retryable) {
            const wait = Math.min(Math.max(err.retryAfter || 5000, 3000), 60000);
            state.retryAt = Date.now() + wait;
            clearTimeout(retryTimer);
            retryTimer = setTimeout(() => {
              state.retryAt = 0;
              pump();
            }, wait);
          } else {
            state.fatal = err?.message || String(err);
          }
        })
        .finally(() => {
          state.active--;
          pump();
        });
    }
    render();
  }

  function applyAll() {
    for (const [node, rec] of store) {
      if (rec.my === rec.orig) continue;
      node.nodeValue = state.showing === "my" ? rec.my : rec.orig;
      if (state.showing === "my") node.parentElement?.setAttribute(MARK, "1");
      else node.parentElement?.removeAttribute(MARK);
    }
  }

  // ---- pill (top frame only)

  function ensurePill() {
    if (!IS_TOP || (host && host.isConnected)) return;
    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("translate", "no");
    shadow = host.attachShadow({ mode: "closed" }); // page scripts cannot reach the buttons
    shadow.innerHTML = `
      <style>
        :host { all: initial; position: fixed; z-index: 2147483647; --gap: 16px; }
        :host([data-corner="br"]) { right: var(--gap); bottom: var(--gap); }
        :host([data-corner="bl"]) { left: var(--gap); bottom: var(--gap); }
        :host([data-corner="tr"]) { right: var(--gap); top: var(--gap); }
        :host([data-corner="tl"]) { left: var(--gap); top: var(--gap); }
        @media print { :host { display: none; } }
        .pill { display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 10px;
          background: #0f1a2b; color: #e7ecf3; border: 1px solid #26374f; border-radius: 999px;
          font: 13px/1.3 -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.35);
          cursor: grab; user-select: none; touch-action: none; }
        .pill.dragging { cursor: grabbing; opacity: .85; }
        .grip { color: #93a2b8; font-size: 12px; letter-spacing: -3px; padding-right: 2px; }
        :host([data-collapsed]) .pill { width: 30px; height: 30px; padding: 0; justify-content: center; cursor: pointer; }
        :host([data-collapsed]) .pill > :not(.dot) { display: none; }
        :host([data-collapsed]) .dot { width: 12px; height: 12px; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #f2a93b; flex: none; }
        .dot.busy { animation: pulse 1s ease-in-out infinite; }
        .dot.done { background: #3fb950; }
        .dot.idle { background: #93a2b8; }
        .dot.error { background: #f28b3b; }
        @keyframes pulse { 0%,100% { opacity: 1; transform: scale(1);} 50% { opacity: .35; transform: scale(.7);} }
        .msg { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        button { font: inherit; cursor: pointer; border-radius: 999px; }
        .toggle { background: transparent; color: #f2a93b; border: 1px solid #f2a93b; padding: 3px 10px; }
        .toggle:hover { background: #f2a93b; color: #241705; }
        .auto { background: transparent; color: #93a2b8; border: 1px solid #26374f; padding: 3px 10px; }
        .auto:hover { color: #e7ecf3; border-color: #93a2b8; }
        .auto.on { color: #3fb950; border-color: #3fb950; }
        .min, .close { background: transparent; color: #93a2b8; border: none; padding: 0 3px; font-size: 16px; line-height: 1; }
        .min:hover, .close:hover { color: #e7ecf3; }
      </style>
      <div class="pill" title="Drag to another corner">
        <span class="grip">⋮⋮</span>
        <span class="dot"></span>
        <span class="msg"></span>
        <button class="toggle"></button>
        <button class="auto"></button>
        <button class="min" title="Minimize to a dot (click the dot to expand)">–</button>
        <button class="close" title="Stop translating on this page and hide">×</button>
      </div>`;
    pillEl = shadow.querySelector(".pill");
    dotEl = shadow.querySelector(".dot");
    msgEl = shadow.querySelector(".msg");
    toggleBtn = shadow.querySelector(".toggle");
    autoBtn = shadow.querySelector(".auto");
    // only real clicks count: a page cannot toggle anything with synthetic events
    toggleBtn.addEventListener("click", (e) => e.isTrusted && toggle());
    autoBtn.addEventListener("click", (e) => e.isTrusted && setAuto(state.autoNeedsGrant || !state.auto));
    shadow.querySelector(".min").addEventListener("click", (e) => e.isTrusted && setCollapsed(true));
    shadow.querySelector(".close").addEventListener("click", (e) => e.isTrusted && stop());
    wireDrag();
    host.dataset.corner = pillPrefs.corner;
    if (pillPrefs.collapsed) host.setAttribute("data-collapsed", "");
    document.documentElement.appendChild(host);
  }

  // Drag the pill anywhere; on release it snaps to the nearest screen corner.
  // A plain click on the collapsed dot expands it. Only trusted input counts.
  function wireDrag() {
    let drag = null;
    let suppressClick = false;
    pillEl.addEventListener("pointerdown", (e) => {
      if (!e.isTrusted || e.button !== 0) return;
      if (e.target.closest("button") && !host.hasAttribute("data-collapsed")) return; // buttons keep their clicks
      drag = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
      pillEl.setPointerCapture(e.pointerId);
    });
    pillEl.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      drag.moved = true;
      pillEl.classList.add("dragging");
      host.style.transform = `translate(${dx}px, ${dy}px)`;
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      pillEl.classList.remove("dragging");
      host.style.transform = "";
      if (!moved) return;
      setCorner((e.clientY < innerHeight / 2 ? "t" : "b") + (e.clientX < innerWidth / 2 ? "l" : "r"));
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
    };
    pillEl.addEventListener("pointerup", end);
    pillEl.addEventListener("pointercancel", end);
    pillEl.addEventListener("click", (e) => {
      if (!e.isTrusted || suppressClick || e.target.closest("button")) return; // buttons handle their own clicks
      if (host.hasAttribute("data-collapsed")) setCollapsed(false);
    });
  }

  function setCorner(corner) {
    pillPrefs.corner = corner;
    if (host) host.dataset.corner = corner;
    savePillPrefs();
  }

  function setCollapsed(collapsed) {
    pillPrefs.collapsed = collapsed;
    if (host) host.toggleAttribute("data-collapsed", collapsed);
    savePillPrefs();
    render();
  }

  function savePillPrefs() {
    chrome.storage?.local?.set({ pill: { ...pillPrefs } }).catch(() => {});
  }

  async function loadPillPrefs() {
    if (!IS_TOP || !chrome.storage?.local) return;
    try {
      const { pill } = await chrome.storage.local.get("pill");
      if (pill && ["tl", "tr", "bl", "br"].includes(pill.corner)) pillPrefs.corner = pill.corner;
      if (pill && typeof pill.collapsed === "boolean") pillPrefs.collapsed = pill.collapsed;
    } catch {}
    if (host) {
      host.dataset.corner = pillPrefs.corner;
      host.toggleAttribute("data-collapsed", pillPrefs.collapsed);
    }
  }

  function render() {
    // Only run() creates the pill; a stale instance (after an extension reload)
    // or a page that removed the host must not bring it back.
    if (state.stopped || !host?.isConnected) return;
    const n = state.translated;
    const count = `${n} fragment${n === 1 ? "" : "s"}`;
    let text, kind;
    if (state.fatal) {
      text = state.fatal;
      kind = "error";
    } else if (state.notice) {
      text = state.notice;
      kind = "idle";
    } else if (state.showing === "orig") {
      text = `Original shown · ${count} translated`;
      kind = "idle";
    } else if (state.retryAt > Date.now()) {
      text = `Gemini is busy — retrying in ${Math.ceil((state.retryAt - Date.now()) / 1000)} s`;
      kind = "busy";
    } else if (state.active || queue.length) {
      text = `Translating… ${count} so far`;
      kind = "busy";
    } else if (state.sentChars >= MAX_PAGE_CHARS) {
      text = `Burmese · ${count} · page limit reached`;
      kind = "done";
    } else if (n) {
      text = `Burmese · ${count}${state.cached ? ` (${state.cached} from cache)` : ""}`;
      kind = "done";
    } else if (state.waiting || deferred.size) {
      text = "Waiting for text to come into view…";
      kind = "busy";
    } else {
      text = "Nothing to translate on this page.";
      kind = "idle";
    }
    msgEl.textContent = text;
    msgEl.title = text;
    pillEl.title = host.hasAttribute("data-collapsed") ? `${text} — click to expand, drag to move` : "Drag to another corner";
    dotEl.className = `dot ${kind}`;
    if (state.fatal && host.hasAttribute("data-collapsed")) setCollapsed(false); // errors must be seen
    toggleBtn.textContent = state.showing === "my" ? "Show original" : "Show Burmese";
    toggleBtn.hidden = n === 0;
    if (state.autoNeedsGrant) {
      autoBtn.textContent = "Auto: allow site access";
      autoBtn.className = "auto";
      autoBtn.title = `${SITE} is on your auto list but Chrome no longer holds permission for it. Click to allow it again.`;
    } else {
      autoBtn.textContent = state.auto ? "Auto: on" : "Auto on this site";
      autoBtn.className = state.auto ? "auto on" : "auto";
      autoBtn.title = state.auto
        ? `Every page on ${SITE} translates as it loads. Click to turn that off.`
        : `Translate every page on ${SITE} automatically as it loads.`;
    }
  }

  function setShowing(showing) {
    state.showing = showing;
    applyAll();
    pump();
  }

  function toggle() {
    setShowing(state.showing === "my" ? "orig" : "my");
    if (IS_TOP) chrome.runtime.sendMessage({ type: "frames-showing", showing: state.showing }).catch(() => {});
  }

  function stop() {
    state.stopped = true; // the queue keeps filling silently; the next run resumes it
    host?.remove();
  }

  // Per-site auto mode is decided by background.js (it holds the site list and
  // the optional host permission). Turning it on needs that permission; the
  // click's gesture usually carries through, otherwise the settings page opens.
  async function readAuto() {
    if (!IS_TOP) return;
    try {
      const r = await chrome.runtime.sendMessage({ type: "auto-get" });
      state.auto = !!r?.on;
      state.autoNeedsGrant = !!r?.listed && !r?.granted;
    } catch {}
    render();
  }

  async function setAuto(on) {
    let r;
    try {
      r = await chrome.runtime.sendMessage({ type: "auto-set", on });
    } catch {
      return;
    }
    state.auto = !!r?.on;
    state.autoNeedsGrant = false;
    state.notice = r?.needsOptions ? "Finish turning Auto on in the settings tab that just opened." : null;
    render();
    if (state.notice) setTimeout(() => { state.notice = null; render(); }, 8000);
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type === "set-showing" && !IS_TOP && (m.showing === "my" || m.showing === "orig")) setShowing(m.showing);
  });

  function run() {
    state.stopped = false;
    state.fatal = null;
    state.retryAt = 0;
    clearTimeout(retryTimer);
    if (!io) io = new IntersectionObserver(onIntersect, { rootMargin: LOOKAHEAD });
    if (!mo) {
      mo = new MutationObserver(onMutations);
      mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }
    if (state.showing === "orig") {
      state.showing = "my";
      applyAll();
    }
    loadPillPrefs().then(ensurePill);
    ensurePill();
    readAuto();
    observeAll();
    pump();
  }

  const buttonRects = () => Object.fromEntries([...(shadow?.querySelectorAll("button") || [])].map((b) => [b.className, b.getBoundingClientRect().toJSON()]));
  window.__gptBurmese = { run, toggle, stop, setAuto, setCollapsed, setCorner, buttonRects, store, state, queue };
  run();
})();
