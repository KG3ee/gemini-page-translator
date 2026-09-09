const translateBtn = document.getElementById("translateBtn");
const statusEl = document.getElementById("status");
const outputEl = document.getElementById("output");
const noKeyNotice = document.getElementById("noKeyNotice");
const pageInfoEl = document.getElementById("pageInfo");

document.getElementById("settingsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById("openOptionsLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

function setStatus(text, isError) {
  if (!text) {
    statusEl.hidden = true;
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.classList.toggle("error", !!isError);
}

// Injected into the page. Must be self-contained (no closures over outer scope).
function extractPageText() {
  const clone = document.body.cloneNode(true);
  const junkSelector =
    "script,style,noscript,svg,iframe,nav,footer,header,form,button,input,textarea,select,[aria-hidden='true']";
  clone.querySelectorAll(junkSelector).forEach((el) => el.remove());

  const root = clone.querySelector("main") || clone.querySelector("article") || clone;
  let text = (root.textContent || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  const MAX = 18000;
  const truncated = text.length > MAX;
  if (truncated) text = text.slice(0, MAX);

  return { title: document.title, url: location.href, text, truncated };
}

function buildPrompt(pageText) {
  return [
    "You are translating an English webpage into Burmese for a computer-science student who is comfortable coding but reads course material faster in Burmese (source: freeCodeCamp, HackTheBox, and similar technical sites).",
    "",
    "Translate the following webpage text into natural, plain Burmese.",
    "Rules:",
    "- Keep all code snippets, terminal commands, file paths, URLs, and variable/function names EXACTLY as-is, never translate them.",
    "- Common programming terms that Myanmar developers normally keep in English (e.g. function, array, API, server, string) may stay in English inside the Burmese sentence if translating them would be confusing.",
    "- NEVER transliterate technical terms into Burmese script. Write them in English exactly as they appear.",
    "- Use the clear, natural register an educated Myanmar developer would use when explaining the topic to a peer — not stiff literary Burmese. Keep the meaning exact; do not paraphrase away details.",
    "- Preserve the original paragraph and list structure.",
    "- Output ONLY the translated text, with no preamble, notes, or explanations about the translation itself.",
    "",
    'Webpage text:\n"""',
    pageText,
    '"""',
  ].join("\n");
}

async function callGemini(apiKey, model, pageText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(pageText) }] }],
    }),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = data?.error?.message || `Gemini request failed (${res.status})`;
    throw new Error(msg);
  }

  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  if (!text) throw new Error("Gemini returned an empty response.");
  return text;
}

function renderOutput(text) {
  outputEl.innerHTML = "";
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .forEach((para) => {
      const p = document.createElement("p");
      p.textContent = para;
      outputEl.appendChild(p);
    });
}

async function getSettings() {
  const { apiKey, model } = await chrome.storage.local.get(["apiKey", "model"]);
  return { apiKey: apiKey || "", model: model || "gemini-3.8-flash" };
}

async function handleTranslate() {
  outputEl.innerHTML = "";
  setStatus("");
  noKeyNotice.hidden = true;

  const { apiKey, model } = await getSettings();
  if (!apiKey) {
    noKeyNotice.hidden = false;
    return;
  }

  translateBtn.disabled = true;
  setStatus("Reading the page…");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab found.");

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageText,
    });

    if (!result?.text) throw new Error("Couldn't find readable text on this page.");

    pageInfoEl.textContent = result.title || result.url || "";
    setStatus(
      result.truncated
        ? "Translating (page was long, translating the first part)…"
        : "Translating…"
    );

    const translated = await callGemini(apiKey, model, result.text);
    renderOutput(translated);
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Something went wrong.", true);
  } finally {
    translateBtn.disabled = false;
  }
}

translateBtn.addEventListener("click", handleTranslate);

(async () => {
  const { apiKey } = await getSettings();
  noKeyNotice.hidden = !!apiKey;
})();
