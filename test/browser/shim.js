// Browser harness for content.js (no network, no extension): a fake chrome.* whose "model"
// answers after `delay` ms. Serve the repo root and open /test/browser/index.html, then
// inject content.js and drive window.__shim from the console (see README, "Testing").
// Faithful to Chrome on one point that matters: port.disconnect() from the calling side
// does NOT fire that side's own onDisconnect.
(() => {
  const sh = (window.__shim = { model: "openai/gpt-5.6-luna", delay: 1500, open: 0, requests: [], log: [] });
  const msgL = [], storL = [];
  const ev = () => { const ls = []; return { ls, addListener: (f) => ls.push(f), removeListener() {} }; };
  const models = ["openai/gpt-5.6-luna", "openai/gpt-6-luna", "google/gemini-3.6-flash"].map((id) => ({ id, label: id, compact: id, text: id, price: [1, 2] }));
  window.chrome = {
    runtime: {
      id: "x",
      onMessage: { addListener: (f) => msgL.push(f) },
      sendMessage: async (m) => {
        if (m.type === "models-get") return { provider: "openrouter", selected: sh.model, models };
        if (m.type === "set-model") { sh.setModel(m.model); return { ok: true, model: m.model }; }
        return {};
      },
      connect: () => {
        const onMessage = ev(), onDisconnect = ev();
        let closed = false;
        return {
          onMessage, onDisconnect,
          disconnect() { if (!closed) { closed = true; sh.open--; } },
          postMessage(m) {
            const model = sh.model;
            sh.open++;
            sh.requests.push({ model, n: m.fragments.length });
            setTimeout(() => {
              if (closed) return;
              m.fragments.forEach((f, i) => onMessage.ls.forEach((g) => g({ type: "partial", i, text: `[${model.split("/")[1]}] ${f}` })));
              onMessage.ls.forEach((g) => g({ type: "done", cached: 0, mismatch: false, models: [model] }));
              closed = true;
              sh.open--;
            }, sh.delay);
          },
        };
      },
    },
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: (f) => storL.push(f) } },
  };
  // what background.js does for set-model / what the settings page or another tab does: a storage write
  sh.setModel = (model) => {
    const old = sh.model;
    sh.model = model;
    if (old !== model) setTimeout(() => storL.forEach((f) => f({ openrouterModel: { oldValue: old, newValue: model } }, "local")), 0);
  };
})();
