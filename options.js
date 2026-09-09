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
  for (const site of autoSites) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = site;
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.className = "secondary";
    btn.addEventListener("click", async () => {
      await chrome.storage.local.set({ autoSites: autoSites.filter((h) => h !== site) });
    });
    li.append(name, btn);
    autoSitesEl.appendChild(li);
  }
}
chrome.storage.onChanged.addListener((changes) => {
  if (changes.autoSites) renderAutoSites();
});
renderAutoSites();
