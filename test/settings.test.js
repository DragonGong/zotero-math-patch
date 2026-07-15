const assert = require("node:assert/strict");
const {
  DEFAULTS,
  DEFAULT_SYSTEM_PROMPT,
  PREF_PREFIX,
  createSettingsStore,
} = require("../chrome/content/settings.js");

module.exports = async function runSettingsTests() {
  const values = new Map();
  const calls = [];
  const prefAPI = {
    get(key, global) {
      assert.equal(global, true);
      return values.get(key);
    },
    set(key, value, global) {
      assert.equal(global, true);
      calls.push({ key, value });
      values.set(key, value);
    },
  };
  let storedKey = "local-secret";
  const credentials = {
    async get() {
      return storedKey;
    },
    async set(value) {
      storedKey = value;
    },
  };
  const store = createSettingsStore(prefAPI, credentials);

  assert.deepEqual(store.getAll(), DEFAULTS, "unset preferences use documented defaults");
  assert.equal(await store.getAPIKey(), "local-secret");
  await store.setAPIKey("replacement-secret");
  assert.equal(storedKey, "replacement-secret");
  assert.equal(Object.prototype.hasOwnProperty.call(DEFAULTS, "apiKey"), false);

  values.set(PREF_PREFIX + "timeoutMs", "9999999");
  values.set(PREF_PREFIX + "maxRequestChars", "bad");
  values.set(PREF_PREFIX + "showPreview", "false");
  values.set(PREF_PREFIX + "processingScope", "invalid");
  assert.equal(store.get("timeoutMs"), 600000);
  assert.equal(store.get("maxRequestChars"), DEFAULTS.maxRequestChars);
  assert.equal(store.get("showPreview"), false);
  assert.equal(store.get("processingScope"), DEFAULTS.processingScope);

  assert.equal(store.set("model", "  deepseek-chat  "), "deepseek-chat");
  assert.deepEqual(calls.at(-1), {
    key: PREF_PREFIX + "model",
    value: "deepseek-chat",
  });
  assert.equal(store.isConfigured({
    providerType: "openai-compatible",
    baseURL: "http://localhost:8000/v1",
    model: "local-model",
  }), true, "API Key is optional for local compatible services");
  assert.equal(store.isConfigured({
    providerType: "openai-compatible",
    baseURL: "",
    model: "local-model",
  }), false);

  const prefDefaults = {};
  const previousPref = global.pref;
  global.pref = (key, value) => {
    prefDefaults[key] = value;
  };
  delete require.cache[require.resolve("../prefs.js")];
  require("../prefs.js");
  global.pref = previousPref;
  assert.equal(prefDefaults[PREF_PREFIX + "systemPrompt"], DEFAULT_SYSTEM_PROMPT);
  assert.equal(prefDefaults[PREF_PREFIX + "showPreview"], true);
  assert.equal(prefDefaults[PREF_PREFIX + "timeoutMs"], DEFAULTS.timeoutMs);
  assert.equal(Object.keys(prefDefaults).some((key) => /api.?key/i.test(key)), false);

  console.log("settings tests passed");
};
