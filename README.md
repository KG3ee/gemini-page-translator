# Gemini Page Translator

Chrome extension that translates the page you're reading into Burmese, using your own Gemini API key. Built for reading English CS material (freeCodeCamp, HackTheBox, docs) — code, commands, file paths, and URLs are left untouched; only the prose is translated.

## Install (unpacked, for personal use)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (on the Ubuntu laptop: `~/Projects/gemini-page-translator`).
4. Click the extension icon, then the ⚙ icon, and paste your Gemini API key (free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)).

After editing any file, click **Reload** on `chrome://extensions`.

## Use

**In place (default).** Right-click anywhere on a page → **Translate to Burmese with Gemini**, or press `Alt+Shift+B`. The page's text is replaced with Burmese where it stands; layout, links, images and code blocks stay exactly as they were. A small pill shows progress and has a **Show original / Show Burmese** toggle; its × stops translating (run it again to resume). Drag the pill to any corner of the screen if it covers something, or press – to shrink it to a dot (click the dot to expand). The corner and the minimized state are remembered on every page.

**Auto on this site.** The pill has an **Auto on this site** button. Turn it on and every page you open on that domain translates by itself as it loads — the equivalent of Chrome's "Always translate English", but through Gemini. Chrome asks once for permission to read that site; the extension holds no standing access to any other site. Turn auto off from the same button, or from the list on the settings page, where you can also limit an entry to one section (`freecodecamp.org/learn`). The pill's × only stops the current page; it does not switch auto off.

Translations stream in: each fragment appears the moment the model finishes it, so a long batch fills in progressively instead of landing all at once. Text inside web components (open shadow roots) and same-origin frames is covered; the pill lives in the top frame and its toggle applies to the frames too.

Only text near what you are looking at is sent: the screen you see plus one screen ahead. As you scroll, the next part goes out, so a long page you only skim costs almost nothing. Text that appears later (next lesson in a single-page app, an expanded section) is picked up automatically.

**Side panel (fallback).** Click the toolbar icon → **Translate in this panel instead** to get the translation next to the untouched page.

## Notes

- The API key lives only in `chrome.storage.local` on this machine and is sent as a request header straight to Google's Gemini endpoint — never in a URL, never to any other server. Anyone with access to the Chrome profile directory can read it, so restrict the key to the Generative Language API in Google Cloud and rotate it if the laptop is lost.
- What leaves the machine: the page title and the text fragments being translated, for pages you translate. With **Auto on this site** that includes every page of that domain you open while logged in, so switch it on only for reading sites.
- Permissions: the only standing host permission is the Gemini endpoint. A manual translate uses Chrome's `activeTab` grant for that one tab; auto mode asks for an optional permission per site and drops it when the site is removed.
- Text sent: only what is near the viewport, in batches of up to 60 fragments / 5,000 characters, two requests in flight, capped at 300,000 characters per page. Navigation, footers, banners, invisible text, code blocks and code editors (Monaco, CodeMirror, Ace, GitHub's code view) are skipped. Visibility is decided from layout, not from `aria-hidden`: sites such as 16personalities mark their visible questions `aria-hidden` because a screen-reader copy exists, and those must still translate. Side-panel mode sends the first ~18,000 characters in one call.
- Responses are streamed (`streamGenerateContent`, server-sent events) and parsed element by element; a truncated or misaligned answer is reverted and the batch is retried in halves.
- Gemini is called with thinking off (`thinkingLevel: "low"`): translation gains nothing from reasoning and thinking was ~60% of the tokens. The system prompt is kept short (about 300 prompt tokens of overhead per request). Safety filters are off so security course material is not refused.
- Every translated fragment is cached per site and per model (`chrome.storage.local`, up to 50,000 entries, oldest evicted). Revisiting a page or meeting the same text across a site is free and instant. The settings page shows the cache size and has a **Clear cache** button.
- Rate limits and outages are retried with Google's suggested delay; text that could not be sent stays queued and is retried, nothing is dropped. A bad key or model stops with the message in the pill.
- Default model is `gemini-3.8-flash` (accurate, natural Burmese). `gemini-flash-lite-latest` (fastest, rougher) and `gemini-3.1-pro-preview` (best Burmese, slow) are available in settings.
- Pages Chrome refuses to script (`chrome://` pages, the Web Store, the built-in PDF viewer) cannot be translated; the toolbar icon briefly shows ✗.

## Testing without touching your real profile

Run the worker in node with a `chrome` shim (`importScripts = f => vm.runInThisContext(...)`) to hit Gemini for real, and load the folder into a throwaway headless Chrome over the DevTools protocol:

```bash
google-chrome --headless=new --user-data-dir=/tmp/x --remote-debugging-port=9333 --enable-unsafe-extension-debugging about:blank
```

then `Extensions.loadUnpacked` and seed `chrome.storage.local` from the service-worker session.
