# Gemini Page Translator

Chrome extension that translates the page you're currently reading into Burmese, using your own Gemini API key. Built for reading English CS material (freeCodeCamp, HackTheBox, docs) — code, commands, file paths, and URLs are left untouched; only the surrounding prose is translated.

## Install (unpacked, for personal use)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (on the Ubuntu laptop: `~/Projects/gemini-page-translator`).
4. Click the extension icon to open the side panel, then click the ⚙ icon and paste your Gemini API key (free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)).

## Use

Open any article/lesson page, click the extension icon, click **Translate this page**. The Burmese translation appears in the side panel while the original page stays untouched next to it.

## Notes

- The API key lives only in `chrome.storage.local` on this machine and is sent directly to Google's Gemini endpoint — no other server is involved.
- Long pages are truncated to roughly the first 18,000 characters per translation call.
- Default model is `gemini-3.8-flash` (accurate, natural Burmese, ~4 s). `gemini-flash-lite-latest` (fastest, rougher) and `gemini-3.1-pro-preview` (best Burmese, slow) are available in settings.
