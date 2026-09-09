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
