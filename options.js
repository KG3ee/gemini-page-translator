const apiKeyEl = document.getElementById("apiKey");
const modelEl = document.getElementById("model");
const savedMsg = document.getElementById("savedMsg");

(async () => {
  const { apiKey, model } = await chrome.storage.local.get(["apiKey", "model"]);
  if (apiKey) apiKeyEl.value = apiKey;
  if (model) modelEl.value = model;
})();

document.getElementById("saveBtn").addEventListener("click", async () => {
  await chrome.storage.local.set({
    apiKey: apiKeyEl.value.trim(),
    model: modelEl.value,
  });
  savedMsg.hidden = false;
  setTimeout(() => (savedMsg.hidden = true), 1800);
});

const cacheStatsEl = document.getElementById("cacheStats");
async function refreshCacheStats() {
  const { entries, bytes } = await chrome.runtime.sendMessage({ type: "cache-stats" });
  cacheStatsEl.textContent = entries
    ? `${entries.toLocaleString()} fragments cached (${(bytes / 1024).toFixed(0)} KB).`
    : "Cache is empty.";
}
document.getElementById("clearCacheBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "cache-clear" });
  refreshCacheStats();
});
refreshCacheStats();

const autoSitesEl = document.getElementById("autoSites");
const autoEntryEl = document.getElementById("autoEntry");
const autoMsgEl = document.getElementById("autoMsg");

function parseEntry(entry) {
  const m = String(entry || "").trim().replace(/^https?:\/\//, "").replace(/^www\./, "").match(/^([^/\s]+)(\/[^\s]*)?$/);
  return m ? { host: m[1].toLowerCase(), path: (m[2] || "/").replace(/\/+$/, "") || "/" } : null;
}
const originsFor = (host) => [`https://${host}/*`, `https://www.${host}/*`, `http://${host}/*`, `http://www.${host}/*`];

function say(text) {
  autoMsgEl.textContent = text;
  autoMsgEl.hidden = !text;
}

async function addEntry(entry) {
  const e = parseEntry(entry);
  if (!e) {
    say("Enter a site like freecodecamp.org or freecodecamp.org/learn.");
    return;
  }
  const granted = await chrome.permissions.request({ origins: originsFor(e.host) }); // needs this click's gesture
  if (!granted) {
    say(`Permission for ${e.host} was not granted, so auto stays off there.`);
    return;
  }
  await chrome.runtime.sendMessage({ type: "auto-add", entry });
  autoEntryEl.value = "";
  say(`Auto is on for ${e.path === "/" ? e.host : e.host + e.path}.`);
  renderAutoSites();
}

document.getElementById("autoAddBtn").addEventListener("click", () => addEntry(autoEntryEl.value));
autoEntryEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") addEntry(autoEntryEl.value);
});

async function renderAutoSites() {
  const { autoSites = [] } = await chrome.storage.local.get("autoSites");
  autoSitesEl.innerHTML = "";
  if (!autoSites.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "None yet.";
    autoSitesEl.appendChild(li);
    return;
  }
  for (const entry of autoSites) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = entry;
    const actions = document.createElement("span");
    const e = parseEntry(entry);
    const granted = e ? await chrome.permissions.contains({ origins: originsFor(e.host) }) : true;
    if (!granted) {
      const allow = document.createElement("button");
      allow.textContent = "Allow";
      allow.title = "Chrome no longer holds permission for this site; click to allow it again.";
      allow.addEventListener("click", async () => {
        await chrome.permissions.request({ origins: originsFor(e.host) }); // this click's gesture
        renderAutoSites();
      });
      name.textContent += " — needs permission";
      actions.appendChild(allow);
    }
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.className = "secondary";
    btn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "auto-remove", entry });
      renderAutoSites();
    });
    actions.appendChild(btn);
    li.append(name, actions);
    autoSitesEl.appendChild(li);
  }
}
chrome.storage.onChanged.addListener((changes) => {
  if (changes.autoSites) renderAutoSites();
});
renderAutoSites();

// Opened by the pill when its click could not carry the permission prompt.
const wanted = new URLSearchParams(location.search).get("enable");
if (wanted) {
  autoEntryEl.value = wanted;
  say(`Click Add to turn Auto on for ${wanted} (Chrome will ask for permission).`);
  autoEntryEl.scrollIntoView({ block: "center" });
  document.getElementById("autoAddBtn").focus();
}
