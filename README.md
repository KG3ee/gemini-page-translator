# Gemini Page Translator

Chrome/Brave extension that translates the page you're reading into Burmese, using your own OpenRouter key (Gemini 4 Argon by default, Gemini 3.1 Pro as the automatic fallback) or, if you prefer, a Gemini API key. Built for reading English CS material (freeCodeCamp, HackTheBox, docs) — code, commands, file paths, and URLs are left untouched; only the prose is translated.

## Install (unpacked, for personal use)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (on the Ubuntu laptop: `~/Projects/gemini-page-translator`).
4. Click the extension icon, then the ⚙ icon, and paste your OpenRouter API key ([openrouter.ai/settings/keys](https://openrouter.ai/settings/keys), with some credit on it). To use Google directly instead, switch **Provider** to Google Gemini and paste a Gemini key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)).

After editing any file, click **Reload** on `chrome://extensions`.

## Use

**In place (default).** Right-click anywhere on a page → **Translate to Burmese**, or press `Alt+Shift+M`. The page's text is replaced with Burmese where it stands; layout, links, images and code blocks stay exactly as they were. A small pill shows progress and has a **Show original / Show Burmese** toggle; its × stops translating (run it again to resume). Drag the pill to any corner of the screen if it covers something, or press – to shrink it to a dot (click the dot to expand). The corner and the minimized state are remembered on every page.

**Auto on this site.** The pill has an **Auto on this site** button. Turn it on and every page you open on that domain translates by itself as it loads — the equivalent of Chrome's "Always translate English", but through your model. Chrome asks once for permission to read that site; the extension holds no standing access to any other site. Turn auto off from the same button, or from the list on the settings page, where you can also limit an entry to one section (`freecodecamp.org/learn`). The pill's × only stops the current page; it does not switch auto off.

Translations stream in: each fragment appears the moment the model finishes it, so a long batch fills in progressively instead of landing all at once. Text inside web components (open shadow roots) and same-origin frames is covered; the pill lives in the top frame and its toggle applies to the frames too.

Only text near what you are looking at is sent: the screen you see plus one screen ahead. As you scroll, the next part goes out, so a long page you only skim costs almost nothing. Text that appears later (next lesson in a single-page app, an expanded section) is picked up automatically.

**Side panel (fallback).** Click the toolbar icon → **Translate in this panel instead** to get the translation next to the untouched page.

## Providers

- **OpenRouter (default).** One key, `https://openrouter.ai/api/v1/chat/completions`, streamed (`stream: true`). Eight models (single list: `OR_MODELS` in `openrouter.js`, prices in the pickers): **Gemini 4 Argon** (`google/gemini-4-argon`, default), **GPT-5.6 Luna** (`openai/gpt-5.6-luna`), **GPT-6 Luna**, **DeepSeek V4 Pro** (`deepseek/deepseek-v4-pro-0813`), **Gemini 3.1 Pro**, **Gemini 3.8 / 3.7 / 3.6 Flash**. Each gets the lowest reasoning setting it accepts (Luna and DeepSeek `none`; Gemini 4 Argon, 3.1 Pro, 3.8 and 3.7 Flash `low`; 3.6 Flash `minimal`); every Gemini is pinned to Google's standard Vertex endpoint (`google-vertex/global`, `service_tier: default`). Every request carries `provider: { data_collection: "deny", zdr: true }` (zero-data-retention endpoints only, no training on your text). If the chosen model fails with anything but a key or credit problem (HTTP 400/404/429/5xx, broken stream, empty answer), its backup answers automatically (Argon, Luna and DeepSeek -> Gemini 3.1 Pro; the other Gemini models -> GPT-5.6 Luna). 401/402/403 stop with a clear message instead, because the same key would fail again (bad key: paste a new one; credit used up: top up at openrouter.ai/settings/credits). No `HTTP-Referer`/`X-Title` headers are sent, so the tool does not show up on OpenRouter's public app lists. Anthropic models are never offered (Burmese quality).
- **Model picker in the pill.** On a translated page the pill has a model select (name + $ in/out per M tokens). Picking one saves it (same storage key as settings) and re-translates the page with it; the cache is per model, so going back is instant. The pill also says which model(s) produced the text on the page ("by GPT-5.6 Luna"); when it is not the picked one (the backup answered, or text came from another model's cache) it shows "fallback" in orange.
- **Google Gemini (direct).** The original path, unchanged (`streamGenerateContent`, thinking `low`, safety filters off). Pick it in settings.
- The model that actually answered decides the cache entry (`openrouter:<slug>`, or the Gemini model name); text already translated by the fallback is reused while the primary is down.

## Notes

- The API key lives only in `chrome.storage.local` on this machine and is sent as a request header straight to OpenRouter (or Google, for the direct Gemini provider) — never in a URL, never to any other server. Anyone with access to the browser profile directory can read it, so give the OpenRouter key a spending limit and rotate it if the laptop is lost.
- What leaves the machine: the page title and the text fragments being translated, for pages you translate. With **Auto on this site** that includes every page of that domain you open while logged in, so switch it on only for reading sites.
- Permissions: the only standing host permissions are the OpenRouter and Gemini endpoints. A manual translate uses Chrome's `activeTab` grant for that one tab; auto mode asks for an optional permission per site and drops it when the site is removed.
- Text sent: only what is near the viewport, in batches of up to 60 fragments / 5,000 characters, two requests in flight, capped at 300,000 characters per page. Navigation, footers, banners, invisible text, code blocks and code editors (Monaco, CodeMirror, Ace, GitHub's code view) are skipped. Visibility is decided from layout, not from `aria-hidden`: sites such as 16personalities mark their visible questions `aria-hidden` because a screen-reader copy exists, and those must still translate. Side-panel mode sends the first ~18,000 characters in one call.
- Responses are streamed (server-sent events: OpenRouter `delta.content`, or Gemini `streamGenerateContent`) and parsed element by element; a truncated or misaligned answer is reverted and the batch is retried in halves.
- Gemini is called with thinking off (`thinkingLevel: "low"`): translation gains nothing from reasoning and thinking was ~60% of the tokens. The system prompt is kept short (about 300 prompt tokens of overhead per request). Safety filters are off so security course material is not refused.
- Every translated fragment is cached per site and per provider+model (`chrome.storage.local`, up to 50,000 entries, oldest evicted). Revisiting a page or meeting the same text across a site is free and instant. The settings page shows the cache size and has a **Clear cache** button.
- Rate limits and outages are retried with Google's suggested delay; text that could not be sent stays queued and is retried, nothing is dropped. A bad key or model stops with the message in the pill.
- Direct-Gemini default model is `gemini-3.8-flash` (accurate, natural Burmese). `gemini-flash-lite-latest` (fastest, rougher) and `gemini-3.1-pro-preview` (best Burmese, slow) are available in settings.
- Pages Chrome refuses to script (`chrome://` pages, the Web Store, the built-in PDF viewer) cannot be translated; the toolbar icon briefly shows ✗.

## Tests

```bash
node --test test/openrouter.test.mjs                                  # SSE parser, request builder, stream reader (no network)
(set -a; . ~/.config/openrouter.env; set +a; node test/e2e-openrouter.mjs [primary-slug])   # real OpenRouter call through background.js
(set -a; . ~/.config/openrouter.env; set +a; node test/e2e-models.mjs <slug> [<slug> ...])  # one tiny real call per slug, fallback off
# pill switch harness (no network): serve the repo (python3 -m http.server), open /test/browser/index.html, inject /content.js, drive window.__shim (setModel, requests, open); see test/browser/shim.js
```

## Changelog

- **1.9.1** — Default model is now Gemini 4 Argon (fallback Gemini 3.1 Pro). One-time migration on update sets the stored model to Argon once; later picks stick.
- **1.9.0** — Eight OpenRouter models (adds GPT-6 Luna, DeepSeek V4 Pro, Gemini 4 Argon, Gemini 3.8 / 3.7 / 3.6 Flash) with prices in the settings dropdown. Model select in the in-page pill: pick a model and the page re-translates with it. The pill shows which model actually answered (and flags a fallback). Follow-up fixes: a switch now cancels in-flight requests cleanly and re-collects below-the-fold text; a model change made in another tab or in settings re-translates every live page; the select commits after a 600 ms pause; DeepSeek V4 Pro skips fp4-quantized hosts (`quantizations` filter, ZDR kept).
- **1.8.0** — OpenRouter provider (default): GPT-5.6 Luna with automatic Gemini 3.1 Pro fallback, zero-data-retention routing on every request; direct Gemini kept as an option. New options page (provider, OpenRouter key, model). Cache keys include provider+model of the model that answered. Review fixes: a failed attempt's text is never mixed into a later answer or cached, a 403 (moderation) falls back to Gemini once, and only listed models are ever sent.
- 1.7.3 — default shortcut `Alt+Shift+M`.

## Testing without touching your real profile

Run the worker in node with a `chrome` shim (`importScripts = f => vm.runInThisContext(...)`) to hit Gemini for real, and load the folder into a throwaway headless Chrome over the DevTools protocol:

```bash
google-chrome --headless=new --user-data-dir=/tmp/x --remote-debugging-port=9333 --enable-unsafe-extension-debugging about:blank
```

then `Extensions.loadUnpacked` and seed `chrome.storage.local` from the service-worker session.
