// node --test test/openrouter.test.mjs   (Node 20+, no dependencies; Node 24 needs the file, not the dir)
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const or = require("../openrouter.js");

const sse = (...evs) => evs.join("");
const delta = (c, extra = {}) => `data: ${JSON.stringify({ id: "x", model: "m/served", choices: [{ delta: { content: c } }], ...extra })}\n\n`;

test("OrSseParser: events, comments, [DONE], CRLF, arbitrary splits", () => {
  const text = ": OPENROUTER PROCESSING\n\n" + delta("a") + ": OPENROUTER PROCESSING\r\n\r\n" + delta("b") + "data: [DONE]\n\n";
  for (const size of [1, 2, 3, 7, 1000]) {
    const p = new or.OrSseParser();
    const got = [];
    for (let i = 0; i < text.length; i += size) got.push(...p.feed(text.slice(i, i + size)));
    got.push(...p.flush());
    assert.deepEqual(got.map((e) => e.choices[0].delta.content), ["a", "b"], `size ${size}`);
  }
});

test("OrSseParser: trailing event without blank line is flushed; junk skipped", () => {
  const p = new or.OrSseParser();
  assert.equal(p.feed("data: {not json}\n\ndata: {\"a\":1}").length, 0);
  assert.deepEqual(p.flush(), [{ a: 1 }]);
});

test("ArrayStringParser: elements arrive one by one, escapes + HTML + code tokens survive", () => {
  const arr = ['<b class="x">Hi</b> `code`', 'line1\nline2 \\ "q"', "{{x}} ⟦CODE_1⟧ မြန်မာ"];
  const json = "```json\n" + JSON.stringify(arr) + "\n```";
  for (const size of [1, 2, 5, 1000]) {
    const p = new or.ArrayStringParser();
    const got = [];
    for (let i = 0; i < json.length; i += size) got.push(...p.feed(json.slice(i, i + size)));
    assert.deepEqual(got, arr, `size ${size}`);
    assert.equal(p.closed, true);
  }
  const p = new or.ArrayStringParser();
  p.feed('["a","b');
  assert.equal(p.closed, false);
});

test("orBuildBody: Luna shape", () => {
  const b = or.orBuildBody("openai/gpt-5.6-luna", [{ role: "user", content: "x" }]);
  assert.equal(b.stream, true);
  assert.deepEqual(b.reasoning, { effort: "none" });
  assert.deepEqual(b.provider, { data_collection: "deny", zdr: true });
  assert.equal(b.service_tier, undefined);
  assert.equal(b.temperature, 0.2);
});

test("orBuildBody: Gemini 3.1 Pro shape (pinned, default tier, never reasoning none)", () => {
  const b = or.orBuildBody("google/gemini-3.1-pro-preview", [], { stream: false });
  assert.equal(b.stream, false);
  assert.deepEqual(b.provider, { data_collection: "deny", zdr: true, order: ["google-vertex/global"], only: ["google-vertex/global"], allow_fallbacks: false });
  assert.equal(b.service_tier, "default");
  assert.notEqual(b.reasoning?.effort, "none");
  assert.ok(["low", "medium", "high"].includes(b.reasoning.effort));
});

test("no Anthropic model anywhere in the list; fallback pairs", () => {
  for (const [slug, cfg] of Object.entries(or.OR_MODELS)) {
    assert.ok(!/anthropic|claude|haiku/i.test(slug + cfg.fallback));
  }
  assert.equal(or.orFallbackFor("openai/gpt-5.6-luna"), "google/gemini-3.1-pro-preview");
  assert.equal(or.orFallbackFor("google/gemini-3.1-pro-preview"), "openai/gpt-5.6-luna");
  assert.equal(or.orFallbackFor("nope/nonexistent"), "google/gemini-3.1-pro-preview");
});

test("orError: 401/402 never fall back, others (403 included) do", () => {
  for (const s of [401, 402]) assert.equal(or.orError(s).noFallback, true);
  for (const s of [400, 403, 404, 429, 500, 502, 0]) assert.equal(or.orError(s).noFallback, false);
  // 403 falls back once: it stops only when it comes from the fallback model
  assert.equal(or.orStops(or.orError(403), true), false);
  assert.equal(or.orStops(or.orError(403), false), true);
  assert.equal(or.orStops(or.orError(401), true), true);
  assert.equal(or.orStops(or.orError(500), false), false);
  assert.match(or.orError(401).message, /key/i);
  assert.match(or.orError(402).message, /openrouter\.ai/);
  assert.equal(or.orRetryable(429), true);
  assert.equal(or.orRetryable(400), false);
});

const fakeFetch = (chunks, init = {}) => async (url, req) => {
  fakeFetch.last = { url, req, body: JSON.parse(req.body) };
  const enc = new TextEncoder();
  return {
    ok: init.ok ?? true, status: init.status ?? 200, headers: new Headers(init.headers || {}),
    json: async () => init.json,
    body: new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); } }),
  };
};

test("orStream: per-element callbacks from delta.content, served model, header + url", async () => {
  const content = JSON.stringify(["one", "two <i>x</i>", "three"]);
  const chunks = [": OPENROUTER PROCESSING\n\n"];
  for (let i = 0; i < content.length; i += 4) chunks.push(delta(content.slice(i, i + 4)));
  chunks.push(`data: ${JSON.stringify({ model: "m/served", choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`, "data: [DONE]\n\n");
  const seen = [];
  const r = await or.orStream({ apiKey: "K", model: "openai/gpt-5.6-luna", messages: [], onElement: (i, s) => seen.push([i, s]), fetchImpl: fakeFetch(chunks) });
  assert.deepEqual(seen, [[0, "one"], [1, "two <i>x</i>"], [2, "three"]]);
  assert.deepEqual(r, { complete: true, model: "m/served", finish: "stop" });
  assert.equal(fakeFetch.last.url, or.OR_ENDPOINT);
  assert.equal(fakeFetch.last.req.headers.Authorization, "Bearer K");
});

test("orStream: HTTP errors, in-stream error, empty answer, truncated array", async () => {
  await assert.rejects(or.orStream({ apiKey: "K", model: "m", messages: [], onElement() {}, fetchImpl: fakeFetch([], { ok: false, status: 401, json: { error: { message: "No auth" } } }) }), (e) => e.status === 401 && e.noFallback);
  await assert.rejects(or.orStream({ apiKey: "K", model: "m", messages: [], onElement() {}, fetchImpl: fakeFetch([`data: ${JSON.stringify({ error: { code: 502, message: "boom" } })}\n\n`]) }), (e) => e.status === 502 && !e.noFallback);
  await assert.rejects(or.orStream({ apiKey: "K", model: "m", messages: [], onElement() {}, fetchImpl: fakeFetch(["data: [DONE]\n\n"]) }), (e) => e.status === 502);
  const r = await or.orStream({ apiKey: "K", model: "m", messages: [], onElement() {}, fetchImpl: fakeFetch([delta('["a","b'), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`]) });
  assert.equal(r.complete, false);
  assert.equal(r.finish, "length");
  await assert.rejects(or.orStream({ apiKey: "K", model: "m", messages: [], onElement() {}, fetchImpl: async () => { throw new TypeError("fetch failed"); } }), (e) => e.status === 0);
});

// ---- background.js streamFragments, run offline in a vm context with fakes
// (chrome.storage, fetch, instant timers); the real prompt.js / openrouter.js / background.js.

const root = new URL("..", import.meta.url).pathname;
const LUNA = "openai/gpt-5.6-luna";
const GEM = "google/gemini-3.1-pro-preview";

function worker(storeInit = {}) {
  const store = { provider: "openrouter", openrouterKey: "sk-or-FAKE", openrouterModel: LUNA, ...storeInit };
  const noop = () => {};
  const ev = { addListener: noop };
  const timers = new Set();
  const ctx = vm.createContext({
    console: { log: noop, info: noop, warn: noop, error: noop },
    TextEncoder, TextDecoder, crypto, Date, Math, Promise,
    setTimeout: (fn, _ms, ...a) => setTimeout(fn, 0, ...a),
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); timers.add(t); return t; },
    clearInterval: (t) => { timers.delete(t); clearInterval(t); },
    chrome: {
      storage: { local: {
        get: async (k) => {
          const keys = Array.isArray(k) ? k : typeof k === "string" ? [k] : Object.keys(k || store);
          return Object.fromEntries(keys.filter((x) => x in store).map((x) => [x, store[x]]));
        },
        set: async (o) => Object.assign(store, o), remove: async () => {}, getBytesInUse: async () => 0,
      }, onChanged: ev },
      runtime: { onMessage: ev, onInstalled: ev, onStartup: ev, onConnect: ev, getPlatformInfo: noop, id: "x", openOptionsPage: noop },
      sidePanel: { setPanelBehavior: async () => {} }, contextMenus: { onClicked: ev, removeAll: noop, create: noop },
      commands: { onCommand: ev }, tabs: { onUpdated: ev, query: async () => [] },
      permissions: { remove: async () => {}, contains: async () => true, onRemoved: ev },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: ev }, scripting: {}, alarms: { onAlarm: ev, create: noop },
    },
  });
  ctx.importScripts = (...f) => { for (const x of f) vm.runInContext(fs.readFileSync(root + x, "utf8"), ctx, { filename: x }); };
  vm.runInContext(fs.readFileSync(root + "background.js", "utf8") + "\n;globalThis.__sf = streamFragments; globalThis.__stamps = stamps;", ctx, { filename: "background.js" });

  const w = { store, calls: [], script: [] };
  ctx.fetch = async (url, init) => {
    w.calls.push({ url, body: JSON.parse(init.body) });
    const step = w.script.shift();
    if (!step) throw new Error("script exhausted");
    return step;
  };
  // returns { result | error, parts, models } for one streamFragments call
  w.run = async (fragments, steps, site = "ex.com") => {
    w.calls = [];
    w.script = steps.slice();
    ctx.__stamps.length = 0;
    const parts = [];
    let result, error;
    try { result = await ctx.__sf(fragments, "T", site, undefined, (m) => parts.push(m)); } catch (e) { error = e; }
    return { result, error, parts, models: w.calls.map((c) => c.body.model), left: w.script.length };
  };
  w.cached = () => Object.entries(store).filter(([k]) => k.startsWith("t:")).map(([, v]) => v.t);
  return w;
}

const enc = new TextEncoder();
const okStream = (arr, model = "m/served") =>
  new Response(new ReadableStream({ start(c) {
    const j = JSON.stringify(arr);
    for (const x of [delta(j.slice(0, 5), { model }), delta(j.slice(5), { model }), "data: [DONE]\n\n"]) c.enqueue(enc.encode(x));
    c.close();
  } }), { status: 200 });
// streams `chunks`, then the connection drops
const brokenStream = (chunks) => {
  let i = 0;
  return new Response(new ReadableStream({ pull(c) { if (i < chunks.length) c.enqueue(enc.encode(chunks[i++])); else c.error(new TypeError("network")); } }), { status: 200 });
};
const httpErr = (status, message = "x") => new Response(JSON.stringify({ error: { message } }), { status });

test("stale padding: Luna drops twice after 3 elements, Gemini closes a 2-element array -> mismatch, nothing cached", async () => {
  const w = worker();
  const p3 = () => brokenStream([delta('["P1","P2","P3"', { model: LUNA })]);
  const r = await w.run(["s1", "s2", "s3"], [p3(), p3(), okStream(["G1", "G2"], GEM)]);
  assert.equal(r.error, undefined);
  assert.equal(r.result.mismatch, true);
  assert.deepEqual(r.models, [LUNA, LUNA, GEM]);
  assert.deepEqual(w.cached(), []); // no mixed ["G1","G2","P3"] result stored
});

test("stale padding: a clean answer after a dropped attempt is cached whole", async () => {
  const w = worker();
  const r = await w.run(["s1", "s2"], [brokenStream([delta('["P1"', { model: LUNA })]), okStream(["A1", "A2"], LUNA)]);
  assert.equal(r.result.mismatch, false);
  assert.deepEqual(w.cached().sort(), ["A1", "A2"]);
});

test("stale padding: same bug in the direct-Gemini path is closed too", async () => {
  const w = worker({ provider: "gemini", apiKey: "AIza-FAKE", model: "gemini-3.8-flash" });
  const ev = (arr) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: arr }] } }] })}\n\n`;
  const closed = (arr) => new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(ev(JSON.stringify(arr)))); c.close(); } }), { status: 200 });
  const r = await w.run(["s1", "s2", "s3"], [brokenStream([ev('["P1","P2","P3"')]), closed(["G1", "G2"])]);
  assert.equal(r.error, undefined);
  assert.equal(r.result.mismatch, true);
  assert.deepEqual(w.cached(), []);
  const ok = await w.run(["u1", "u2"], [brokenStream([ev('["P1"')]), closed(["G1", "G2"])]);
  assert.equal(ok.result.mismatch, false);
  assert.deepEqual(w.cached().sort(), ["G1", "G2"]);
});

test("403 from Luna falls back to Gemini once, and the answer is cached under Gemini", async () => {
  const w = worker();
  const r = await w.run(["h1", "h2"], [httpErr(403, "flagged"), okStream(["G1", "G2"], GEM)]);
  assert.equal(r.error, undefined);
  assert.equal(r.result.mismatch, false);
  assert.deepEqual(r.models, [LUNA, GEM]); // no same-model retry on 403
  assert.deepEqual(w.cached().sort(), ["G1", "G2"]);
});

test("403 on both models stops with the clear message after exactly two calls", async () => {
  const w = worker();
  const r = await w.run(["h3"], [httpErr(403, "flagged"), httpErr(403, "flagged"), okStream(["never"])]);
  assert.match(r.error.message, /refused this key or request/);
  assert.match(r.error.message, /openrouter\.ai\/settings\/keys/);
  assert.deepEqual(r.models, [LUNA, GEM]);
  assert.equal(r.left, 1);
});

test("401/402 on Luna and 401 on the fallback still stop at once", async () => {
  for (const s of [401, 402]) {
    const w = worker();
    const r = await w.run(["k" + s], [httpErr(s), okStream(["never"])]);
    assert.ok(r.error);
    assert.deepEqual(r.models, [LUNA]);
  }
  const w = worker();
  const r = await w.run(["k500"], [httpErr(500), httpErr(500), httpErr(401)]);
  assert.match(r.error.message, /rejected the key/);
  assert.deepEqual(r.models, [LUNA, LUNA, GEM]);
});

test("model allow-list: a Haiku / inherited slug in storage is clamped to the default", async () => {
  assert.equal(or.orClampModel("anthropic/claude-haiku-4.5"), LUNA);
  for (const bad of ["constructor", "__proto__", "toString", "", undefined, null, 7, {}]) assert.equal(or.orClampModel(bad), LUNA);
  assert.equal(or.orClampModel(GEM), GEM);
  for (const slug of ["anthropic/claude-haiku-4.5", "constructor"]) {
    const w = worker({ openrouterModel: slug });
    const r = await w.run(["c" + slug], [okStream(["Z"], LUNA)]);
    assert.deepEqual(r.models, [LUNA], slug);
  }
  const w = worker({ openrouterModel: GEM });
  assert.deepEqual((await w.run(["gem"], [okStream(["Z"], GEM)])).models, [GEM]);
});

// ---- the 8-model picker (v1.9.0)

const EIGHT = [
  "openai/gpt-5.6-luna", "openai/gpt-6-luna", "deepseek/deepseek-v4-pro-0813", "google/gemini-4-argon",
  "google/gemini-3.1-pro-preview", "google/gemini-3.8-flash", "google/gemini-3.7-flash", "google/gemini-3.6-flash",
];

test("orClampModel accepts exactly the 8 models; Anthropic and unknown slugs get the default", () => {
  assert.deepEqual(Object.keys(or.OR_MODELS).sort(), [...EIGHT].sort());
  for (const m of EIGHT) assert.equal(or.orClampModel(m), m);
  for (const bad of ["anthropic/claude-haiku-4.5", "anthropic/claude-opus-5", "google/gemini-3.5-flash", "openai/gpt-7-luna", "deepseek/deepseek-v4-pro", "openai/gpt-6-luna ", "OPENAI/GPT-6-LUNA"]) {
    assert.equal(or.orClampModel(bad), LUNA, bad);
  }
});

test("every model has a defined fallback that is another listed model, never itself, never Anthropic", () => {
  for (const m of EIGHT) {
    const f = or.orFallbackFor(m);
    assert.ok(f && f !== m && Object.hasOwn(or.OR_MODELS, f), `${m} -> ${f}`);
    assert.ok(!/anthropic|claude|haiku/i.test(f));
    assert.equal(or.OR_MODELS[m].fallback, f);
  }
  for (const m of ["openai/gpt-5.6-luna", "openai/gpt-6-luna", "deepseek/deepseek-v4-pro-0813"]) assert.equal(or.orFallbackFor(m), GEM);
  for (const m of EIGHT.filter((x) => x.startsWith("google/"))) assert.equal(or.orFallbackFor(m), LUNA);
});

test("request shape per model: lowest reasoning, ZDR + no training always, Gemini pinned to Vertex", () => {
  const effort = {
    "openai/gpt-5.6-luna": "none", "openai/gpt-6-luna": "none", "deepseek/deepseek-v4-pro-0813": "none",
    "google/gemini-4-argon": "low", "google/gemini-3.1-pro-preview": "low", "google/gemini-3.8-flash": "low",
    "google/gemini-3.7-flash": "low", "google/gemini-3.6-flash": "minimal",
  };
  for (const m of EIGHT) {
    const b = or.orBuildBody(m, []);
    assert.equal(b.reasoning.effort, effort[m], m);
    assert.equal(b.provider.zdr, true, m);
    assert.equal(b.provider.data_collection, "deny", m);
    if (m.startsWith("google/")) {
      assert.deepEqual(b.provider.only, ["google-vertex/global"], m);
      assert.equal(b.provider.allow_fallbacks, false, m);
      assert.equal(b.service_tier, "default", m);
    } else {
      if (m.startsWith("deepseek/")) assert.ok(!b.provider.quantizations.includes("fp4") && !b.provider.quantizations.includes("int4"), m);
      assert.equal(b.provider.only, undefined, m);
      assert.equal(b.service_tier, undefined, m);
    }
  }
});

test("picker list: 8 entries with labels and prices (default first)", () => {
  const list = or.orModelList();
  assert.equal(list.length, 8);
  assert.equal(list[0].id, LUNA);
  assert.match(list.find((m) => m.id === "openai/gpt-6-luna").text, /\$0\.10 in \/ \$0\.50 out/);
  assert.match(list.find((m) => m.id === "deepseek/deepseek-v4-pro-0813").text, /\$1\.32 in \/ \$3\.96 out/);
  assert.match(list.find((m) => m.id === "google/gemini-3.8-flash").text, /\$0\.825 in \/ \$4\.13 out/);
  assert.equal(or.orLabel("openrouter:google/gemini-4-argon"), "Gemini 4 Argon");
  assert.equal(or.orLabel("gemini-3.8-flash"), "gemini-3.8-flash");
});
