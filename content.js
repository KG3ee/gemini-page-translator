// In-place translator. Injected on demand by background.js (context menu,
// shortcut, side panel button, or auto mode on a listed site).
//
// Only text near the viewport is sent: each candidate text node's parent is
// watched by an IntersectionObserver with one screen of look-ahead, and nodes
// are queued as their element comes near. A MutationObserver picks up text
// that appears or changes later (next lesson in a single-page app, expanded
// sections, live counters). Running the script again resumes after
// "Show original" or the × button.
(() => {
  const HOST_ID = "gpt-burmese-host";
  const MARK = "data-gpt-burmese"; // set on the parent of a translated text node

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
    // hidden, assistive-only, icon fonts
    "[hidden]", "[aria-hidden='true']", ".sr-only", ".visually-hidden", ".material-icons", "[class*='material-symbols']",
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
  const queue = [];               // Text nodes near the viewport, waiting to be sent
  const state = {
    showing: "my", active: 0, waiting: 0, translated: 0, cached: 0, sentChars: 0,
    fatal: null, retryAt: 0, stopped: false, auto: false,
  };
  let host, shadow, msgEl, dotEl, toggleBtn, autoBtn, io, mo, observeTimer, observeDeadline = 0, retryTimer;

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

  function collect() {
    const out = [];
    if (!document.body) return out;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || seen.has(node) || p.hasAttribute(MARK) || p.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return isTranslatable(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
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

  async function request(fragments) {
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ type: "translate-fragments", fragments, title: document.title });
    } catch (err) {
      const msg = err?.message || String(err);
      if (/context invalidated/i.test(msg)) throw Object.assign(new Error("The extension was reloaded — run Translate again."), { retryable: false });
      throw Object.assign(new Error(msg), { retryable: true, retryAfter: 5000 }); // worker asleep or restarting
    }
    if (!reply?.ok) {
      throw Object.assign(new Error(reply?.error || "Translation failed."), {
        retryable: !!reply?.retryable,
        retryAfter: reply?.retryAfter || 0,
      });
    }
    state.cached += reply.cached || 0;
    return reply.translations;
  }

  // Length mismatch = the model merged or dropped a fragment; halve twice, then give up on those.
  async function translateBatch(entries, depth = 0) {
    const out = await request(entries.map((e) => e.core));
    if (!Array.isArray(out) || out.length !== entries.length) {
      if (entries.length > 1 && depth < 2) {
        const mid = Math.ceil(entries.length / 2);
        await Promise.all([translateBatch(entries.slice(0, mid), depth + 1), translateBatch(entries.slice(mid), depth + 1)]);
      } else {
        for (const e of entries) store.set(e.node, { orig: e.orig, my: e.orig }); // stays English, not resent
      }
      return;
    }
    entries.forEach((e, i) => {
      if (e.node.nodeValue !== e.orig) {
        seen.delete(e.node); // the page changed it meanwhile; collect() will pick it up again
        return;
      }
      const t = (out[i] || "").trim();
      const rec = { orig: e.orig, my: t ? e.lead + t + e.trail : e.orig };
      store.set(e.node, rec);
      if (!t) return;
      state.translated++;
      if (state.showing === "my") {
        e.node.nodeValue = rec.my;
        e.node.parentElement?.setAttribute(MARK, "1");
      }
    });
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

  // ---- pill

  function ensurePill() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("translate", "no");
    shadow = host.attachShadow({ mode: "closed" }); // page scripts cannot reach the buttons
    shadow.innerHTML = `
      <style>
        :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; }
        @media print { :host { display: none; } }
        .pill { display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 14px;
          background: #0f1a2b; color: #e7ecf3; border: 1px solid #26374f; border-radius: 999px;
          font: 13px/1.3 -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.35); }
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
        .close { background: transparent; color: #93a2b8; border: none; padding: 0 2px; font-size: 16px; line-height: 1; }
        .close:hover { color: #e7ecf3; }
      </style>
      <div class="pill">
        <span class="dot"></span>
        <span class="msg"></span>
        <button class="toggle"></button>
        <button class="auto"></button>
        <button class="close" title="Stop translating on this page and hide">×</button>
      </div>`;
    dotEl = shadow.querySelector(".dot");
    msgEl = shadow.querySelector(".msg");
    toggleBtn = shadow.querySelector(".toggle");
    autoBtn = shadow.querySelector(".auto");
    // only real clicks count: a page cannot toggle anything with synthetic events
    toggleBtn.addEventListener("click", (e) => e.isTrusted && toggle());
    autoBtn.addEventListener("click", (e) => e.isTrusted && setAuto(!state.auto));
    shadow.querySelector(".close").addEventListener("click", (e) => e.isTrusted && stop());
    document.documentElement.appendChild(host);
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
    dotEl.className = `dot ${kind}`;
    toggleBtn.textContent = state.showing === "my" ? "Show original" : "Show Burmese";
    toggleBtn.hidden = n === 0;
    autoBtn.textContent = state.auto ? "Auto: on" : "Auto on this site";
    autoBtn.className = state.auto ? "auto on" : "auto";
    autoBtn.title = state.auto
      ? `Every page on ${SITE} translates as it loads. Click to turn that off.`
      : `Translate every page on ${SITE} automatically as it loads.`;
  }

  function toggle() {
    state.showing = state.showing === "my" ? "orig" : "my";
    applyAll();
    pump();
  }

  function stop() {
    state.stopped = true; // the queue keeps filling silently; the next run resumes it
    host?.remove();
  }

  // Per-site auto mode lives in chrome.storage.local.autoSites; background.js
  // injects this script on every completed page load for listed sites.
  async function readAuto() {
    if (!chrome.storage?.local) return;
    const { autoSites = [] } = await chrome.storage.local.get("autoSites");
    state.auto = autoSites.includes(SITE);
    render();
  }

  async function setAuto(on) {
    if (!chrome.storage?.local) return;
    const { autoSites = [] } = await chrome.storage.local.get("autoSites");
    const next = on ? [...new Set([...autoSites, SITE])] : autoSites.filter((h) => h !== SITE);
    await chrome.storage.local.set({ autoSites: next });
    state.auto = on;
    render();
  }

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
    ensurePill();
    readAuto();
    observeAll();
    pump();
  }

  window.__gptBurmese = { run, toggle, stop, setAuto, store, state, queue };
  run();
})();
