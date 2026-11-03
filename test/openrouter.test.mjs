// node --test test/   (Node 20+, no dependencies)
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
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

test("orError: auth/credit never fall back, others do", () => {
  for (const s of [401, 402, 403]) assert.equal(or.orError(s).noFallback, true);
  for (const s of [400, 404, 429, 500, 502, 0]) assert.equal(or.orError(s).noFallback, false);
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
