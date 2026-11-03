// ONE tiny real OpenRouter call per slug through the extension's own background.js
// (chrome shim), with the fallback switched off so a failing slug fails loudly
// instead of being answered by its backup. Prints the request shape that was sent
// (no key), latency, the provider OpenRouter routed to and the answering model.
//   (set -a; . ~/.config/openrouter.env; set +a; node test/e2e-models.mjs <slug> [<slug> ...])
// Reads OPENROUTER_API_KEY from the environment; never prints it.
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("OPENROUTER_API_KEY not set");
const slugs = process.argv.slice(2);
if (!slugs.length) throw new Error("usage: node test/e2e-models.mjs <slug> [...]");

const store = { provider: "openrouter", openrouterKey: key, openrouterModel: slugs[0] };
const noop = () => {};
const ev = { addListener: noop };
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => {
        if (k === null) return { ...store };
        const keys = Array.isArray(k) ? k : typeof k === "string" ? [k] : Object.keys(k);
        return Object.fromEntries(keys.filter((x) => x in store).map((x) => [x, store[x]]));
      },
      set: async (o) => Object.assign(store, o),
      remove: async () => {}, getBytesInUse: async () => 0,
    },
    onChanged: ev,
  },
  runtime: { onMessage: ev, onInstalled: ev, onStartup: ev, onConnect: ev, getPlatformInfo: noop, id: "x", openOptionsPage: noop },
  sidePanel: { setPanelBehavior: async () => {} },
  contextMenus: { onClicked: ev, removeAll: noop, create: noop },
  commands: { onCommand: ev },
  tabs: { onUpdated: ev, query: async () => [] },
  permissions: { remove: async () => {}, contains: async () => true, onRemoved: ev },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: ev },
  scripting: {}, alarms: { onAlarm: ev, create: noop },
};
globalThis.importScripts = (...fs_) => { for (const f of fs_) vm.runInThisContext(fs.readFileSync(path.join(dir, f), "utf8"), { filename: f }); };
vm.runInThisContext(fs.readFileSync(path.join(dir, "background.js"), "utf8") + "\n;globalThis.__sf = streamFragments;", { filename: "background.js" });


globalThis.orFallbackFor = () => null; // background.js resolves this global at call time
const realFetch = globalThis.fetch;
let seen;
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  seen = { reasoning: body.reasoning, provider: body.provider, service_tier: body.service_tier };
  const res = await realFetch(url, opts);
  if (res.ok) {
    const txt = await res.clone().text();
    seen.routedTo = [...new Set([...txt.matchAll(/"provider":"([^"]+)"/g)].map((m) => m[1]))].join(",");
  } else {
    seen.status = res.status;
  }
  return res;
};

const fragments = ["Click the Run button to start the program."];
let bad = 0;
for (const slug of slugs) {
  store.openrouterModel = slug;
  const log = [];
  const t0 = Date.now();
  let line;
  try {
    const r = await globalThis.__sf(fragments, "Intro", "e2e.test", undefined, (m) => log.push(m));
    const out = log.filter((m) => m.type === "partial").map((m) => m.text);
    const ok = !r.mismatch && out.length === 1 && /[\u1000-\u109F]/.test(out[0]);
    line = { slug, ok, ms: Date.now() - t0, models: r.models, mismatch: r.mismatch, sent: seen, out: out[0] };
    if (!ok) bad++;
  } catch (err) {
    bad++;
    line = { slug, ok: false, ms: Date.now() - t0, error: err.message, sent: seen };
  }
  console.log(JSON.stringify(line));
}
process.exit(bad ? 1 : 0);
