// OpenRouter support, shared by background.js (importScripts), sidepanel.html
// (<script>) and the Node unit tests (require). No chrome.* calls in here.
//
// Every request asks for zero-data-retention endpoints that do not train on the
// prompt. The model list is deliberately short; no Anthropic model (Burmese).
const OR_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const OR_DEFAULT_MODEL = "openai/gpt-5.6-luna";

// Per-model request shape. `reasoning` is the lowest setting the model accepts
// (OpenRouter /models -> reasoning.supported_efforts): Luna takes "none"; Gemini
// 3.1 Pro has mandatory reasoning (high/medium/low), so "low".
// Gemini is pinned to Google's standard Vertex endpoint (not flex/priority).
const OR_MODELS = {
  "openai/gpt-5.6-luna": {
    label: "GPT-5.6 Luna",
    reasoning: { effort: "none" },
    fallback: "google/gemini-3.1-pro-preview",
  },
  "google/gemini-3.1-pro-preview": {
    label: "Gemini 3.1 Pro (via OpenRouter)",
    reasoning: { effort: "low" },
    route: { order: ["google-vertex/global"], only: ["google-vertex/global"], allow_fallbacks: false },
    serviceTier: "default",
    fallback: "openai/gpt-5.6-luna",
  },
};

// Only listed models are ever sent. A slug edited into storage (e.g. an Anthropic
// model, banned for Burmese) or an inherited name like "constructor" gets the default.
function orClampModel(model) {
  return typeof model === "string" && Object.hasOwn(OR_MODELS, model) ? model : OR_DEFAULT_MODEL;
}

// Model to try when `model` fails with something other than auth/credit.
// Unknown slugs fall back to Gemini 3.1 Pro.
function orFallbackFor(model) {
  const f = (Object.hasOwn(OR_MODELS, model) && OR_MODELS[model].fallback) || "google/gemini-3.1-pro-preview";
  return f === model ? null : f;
}

// Does this error end the run instead of moving to the next model? 401/402 always
// (key or credit: the same key fails on the fallback too). 403 is also what
// OpenRouter's moderation returns for a flagged input, so the primary's 403 falls
// back to the other model once; a 403 from the fallback stops.
const orStops = (err, isPrimary) => !!err.noFallback || (!isPrimary && err.status === 403);

function orHeaders(apiKey) {
  // No HTTP-Referer / X-Title: they would list this private tool on OpenRouter's public app rankings.
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}

// `messages` is the OpenAI-format array; `stream` picks SSE or one JSON reply.
function orBuildBody(model, messages, { stream = true } = {}) {
  const cfg = OR_MODELS[model] || {};
  return {
    model,
    messages,
    temperature: 0.2,
    stream,
    ...(cfg.reasoning ? { reasoning: cfg.reasoning } : {}),
    provider: { data_collection: "deny", zdr: true, ...(cfg.route || {}) },
    ...(cfg.serviceTier ? { service_tier: cfg.serviceTier } : {}),
  };
}

// Error for an HTTP status / in-stream error. 401/402 are the key or the credit:
// the fallback uses the same key, so it would fail the same way (noFallback).
// 403 may be the key or a moderation flag on the input; see orStops().
function orError(status, apiMessage) {
  const detail = apiMessage ? ` (${String(apiMessage).slice(0, 200)})` : "";
  let message;
  let noFallback = false;
  if (status === 401) {
    message = "OpenRouter rejected the key (invalid or revoked). Paste a valid key in settings.";
    noFallback = true;
  } else if (status === 402) {
    message = "OpenRouter credit is used up. Top up at openrouter.ai/settings/credits, then try again.";
    noFallback = true;
  } else if (status === 403) {
    message = `OpenRouter refused this key or request${detail}. Check the key at openrouter.ai/settings/keys.`;
  } else if (status === 429) message = "OpenRouter is rate-limiting requests.";
  else if (status >= 500 || status === 408) message = `OpenRouter or the model provider is unavailable (${status}).`;
  else if (status === 0) message = "Could not reach OpenRouter (network).";
  else message = `OpenRouter request failed (${status})${detail}.`;
  return Object.assign(new Error(message), { status, noFallback });
}

// Retry on the same model? (429, 408, 5xx, network, empty answer)
const orRetryable = (status) => status === 0 || status === 408 || status === 429 || status >= 500;

// Server-sent events from OpenRouter: "data: {...}\n\n" events, ": OPENROUTER PROCESSING"
// comment lines as keep-alives, and a final "data: [DONE]". feed() takes text
// as it arrives (any split) and returns the JSON events completed so far.
class OrSseParser {
  constructor() {
    this.buf = "";
  }
  feed(text) {
    this.buf += text.replace(/\r\n?/g, "\n");
    const events = [];
    let idx;
    while ((idx = this.buf.indexOf("\n\n")) >= 0) {
      this.#take(this.buf.slice(0, idx), events);
      this.buf = this.buf.slice(idx + 2);
    }
    return events;
  }
  flush() {
    const events = [];
    if (this.buf.trim()) this.#take(this.buf, events);
    this.buf = "";
    return events;
  }
  #take(block, events) {
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue; // comment / keep-alive
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    const payload = data.join("\n").trim();
    if (!payload || payload === "[DONE]") return;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // a broken event is skipped; completeness is judged on the finished array
    }
  }
}

// Pulls complete string elements out of a JSON array that arrives in pieces.
// Ignores anything before the first "[" (code fences, a preamble) and after the "]".
class ArrayStringParser {
  constructor() {
    this.started = false;
    this.closed = false;
    this.inString = false;
    this.escape = false;
    this.token = "";
  }
  feed(chunk) {
    const out = [];
    for (const ch of chunk) {
      if (this.closed) break;
      if (!this.started) {
        if (ch === "[") this.started = true;
        continue;
      }
      if (this.inString) {
        this.token += ch;
        if (this.escape) this.escape = false;
        else if (ch === "\\") this.escape = true;
        else if (ch === '"') {
          this.inString = false;
          try {
            out.push(JSON.parse(this.token));
          } catch {
            out.push(this.token.slice(1, -1));
          }
          this.token = "";
        }
        continue;
      }
      if (ch === '"') {
        this.inString = true;
        this.token = '"';
      } else if (ch === "]") this.closed = true;
    }
    return out;
  }
}

// One streamed attempt on one model. Calls onElement(i, text) per finished array
// element. Resolves { complete, model, finish }: complete = the array closed
// cleanly; model = the model OpenRouter says answered. Throws orError(...) on
// an HTTP error, an in-stream error, a broken connection or an empty answer.
async function orStream({ apiKey, model, messages, signal, onElement, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(OR_ENDPOINT, {
      method: "POST",
      headers: orHeaders(apiKey),
      body: JSON.stringify(orBuildBody(model, messages, { stream: true })),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw Object.assign(new Error("Cancelled."), { aborted: true });
    throw orError(0);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const retryAfter = parseFloat(res.headers?.get?.("retry-after"));
    throw Object.assign(orError(res.status, data?.error?.message), { retryAfterMs: retryAfter > 0 ? retryAfter * 1000 : 0 });
  }

  const sse = new OrSseParser();
  const parser = new ArrayStringParser();
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let count = 0;
  let got = false;
  let finish = null;
  let servedModel = null;
  const take = (events) => {
    for (const ev of events) {
      if (ev.error) {
        const code = Number(ev.error.code);
        throw orError(code > 0 ? code : 502, ev.error.message);
      }
      if (ev.model) servedModel = ev.model;
      const choice = ev.choices?.[0];
      const piece = choice?.delta?.content;
      if (typeof piece === "string" && piece) {
        got = true;
        for (const s of parser.feed(piece)) onElement(count++, s);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      take(sse.feed(decoder.decode(value, { stream: true })));
    }
    take(sse.feed(decoder.decode()));
    take(sse.flush());
  } catch (err) {
    if (err.status !== undefined) throw err;
    if (signal?.aborted) throw Object.assign(new Error("Cancelled."), { aborted: true });
    throw orError(0);
  }
  if (!got) throw orError(502, "empty answer");
  return { complete: parser.closed, model: servedModel, finish };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    OR_ENDPOINT, OR_DEFAULT_MODEL, OR_MODELS, orClampModel, orFallbackFor, orStops, orHeaders, orBuildBody, orError, orRetryable,
    OrSseParser, ArrayStringParser, orStream,
  };
}
