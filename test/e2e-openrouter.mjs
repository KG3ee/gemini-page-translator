// Real OpenRouter call through the extension's own background.js (chrome shim).
//   (set -a; . ~/.config/openrouter.env; set +a; node test/e2e-openrouter.mjs [primary-slug])
// Reads OPENROUTER_API_KEY from the environment; never prints it.
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("OPENROUTER_API_KEY not set");
const primary = process.argv[2] || "openai/gpt-5.6-luna";

const store = { provider: "openrouter", openrouterKey: key, openrouterModel: primary };
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

const fragments = [
  'Click the <button class="btn">Run</button> button to execute `npm install` in your terminal.',
  "A function is a reusable block of code. Call it with myFunction(arg1, arg2).",
  "Open /etc/passwd and read the file at https://example.com/docs?x=1 carefully.",
  "Section 2: Loops",
  "{{user.name}} has {count} items in the ⟦CODE_1⟧ array.",
];
const log = [];
const t0 = Date.now();
const r = await globalThis.__sf(fragments, "Intro to recursion", "e2e.test", undefined, (m) => log.push(m));
console.log("primary:", primary, "| result:", JSON.stringify(r), "| ms:", Date.now() - t0);
const out = [];
for (const m of log) if (m.type === "partial") out[m.i] = m.text;
out.forEach((t, i) => console.log(`${i}: ${t}`));
const cacheKeys = Object.keys(store).filter((k) => k.startsWith("t:"));
console.log("cache entries written:", cacheKeys.length);
for (const tok of ["`npm install`", '<button class="btn">', "myFunction(arg1, arg2)", "/etc/passwd", "https://example.com/docs?x=1", "{{user.name}}", "{count}", "⟦CODE_1⟧"]) {
  console.log("token", tok, out.join("\n").includes(tok) ? "OK" : "MISSING");
}

// Second pass: same texts must now come from the cache (stored under the model that answered).
const again = await globalThis.__sf(fragments, "Intro to recursion", "e2e.test", undefined, () => {});
console.log("second pass:", JSON.stringify(again), again.cached === fragments.length ? "OK (all from cache)" : "NOT CACHED");
