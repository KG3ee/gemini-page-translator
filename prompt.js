// Shared translation settings. Loaded by sidepanel.html (<script>) and by
// background.js (importScripts), so both translation modes use the same rules.
const GPT_DEFAULT_MODEL = "gemini-3.8-flash";

const GPT_AUDIENCE =
  "Reader: a Myanmar computer-science student who codes but reads technical pages (freeCodeCamp, HackTheBox, docs) faster in Burmese.";

const GPT_RULES = [
  "Keep code, commands, file paths, URLs and variable/function/class names exactly as written.",
  "Programming terms Myanmar developers keep in English (function, array, API, server, string, loop, variable) may stay English inside the Burmese sentence.",
  "Never transliterate technical terms into Burmese script.",
  "Write natural Burmese, like a developer explaining to a peer, not literary Burmese; keep the meaning exact.",
];
