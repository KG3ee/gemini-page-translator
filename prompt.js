// Shared translation settings. Loaded by sidepanel.html (<script>) and by
// background.js (importScripts), so both translation modes use the same rules.
const GPT_DEFAULT_MODEL = "gemini-3.8-flash";

const GPT_AUDIENCE =
  "Reader: a Myanmar computer-science student who codes but reads technical pages (freeCodeCamp, HackTheBox, docs) faster in Burmese.";

const GPT_RULES = [
  "Keep code, commands, file paths, URLs and variable/function/class names exactly as written.",
  "Words that have no direct Burmese translation (tech terms and app/product words such as app, bot, domain, email, link, browser, server, API, function, array, string, loop, variable) MUST be written in English letters inside the Burmese sentence. Never spell an English word in Burmese script and never invent a Burmese transliteration.",
  "Write natural Burmese, like a developer explaining to a peer, not literary Burmese; keep the meaning exact.",
];
