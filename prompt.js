// Shared translation settings. Loaded by sidepanel.html (<script>) and by
// background.js (importScripts), so both translation modes use the same rules.
const GPT_DEFAULT_MODEL = "gemini-3.8-flash";

const GPT_AUDIENCE =
  "Reader: a Myanmar computer-science student who codes but reads technical pages (freeCodeCamp, HackTheBox, docs) faster in Burmese.";

const GPT_RULES = [
  "Keep code, commands, file paths, URLs and variable/function/class names exactly as written.",
  "Do not translate technical words or words that have no direct Burmese translation (for example domain, bot, card, bill, app, website, or similar). Write the original English word in English letters; never spell an English word in Burmese script.",
  "Write natural Burmese, like a developer explaining to a peer, not literary Burmese; keep the meaning exact.",
];
