// Shared translation settings. Loaded by sidepanel.html (<script>) and by
// background.js (importScripts), so both translation modes use the same rules.
const GPT_DEFAULT_MODEL = "gemini-3.8-flash";

const GPT_AUDIENCE =
  "The reader is a Myanmar computer-science student who is comfortable coding but reads technical course material faster in Burmese (freeCodeCamp, HackTheBox, documentation and similar sites).";

const GPT_RULES = [
  "Keep all code snippets, terminal commands, file paths, URLs, and variable/function/class names EXACTLY as-is; never translate them.",
  "Common programming terms that Myanmar developers normally keep in English (e.g. function, array, API, server, string, loop, variable) may stay in English inside the Burmese sentence if translating them would be confusing.",
  "NEVER transliterate technical terms into Burmese script. Write them in English exactly as they appear.",
  "Use the clear, natural register an educated Myanmar developer would use when explaining the topic to a peer — not stiff literary Burmese. Keep the meaning exact; do not paraphrase away details.",
];
