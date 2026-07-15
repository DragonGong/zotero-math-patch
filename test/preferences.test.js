const assert = require("node:assert/strict");

module.exports = async function runPreferencePaneTests() {
  const originals = captureGlobals(["window", "document", "Zotero"]);
  const elements = createElements();
  const savedKeys = [];
  const debugMessages = [];
  const prefWrites = [];
  let capturedConfig;
  let resolveConnection;
  let connectionPromise = new Promise((resolve) => {
    resolveConnection = resolve;
  });

  global.window = {};
  global.document = {
    getElementById(id) {
      return elements[id] || null;
    },
  };
  global.Zotero = {
    MathPatch: {
      async getAPIKey() {
        return "stored-secret";
      },
      async setAPIKey(value) {
        savedKeys.push(value);
      },
      testAIConnection(config) {
        capturedConfig = config;
        return connectionPromise;
      },
      getDefaultSystemPrompt() {
        return "default prompt";
      },
    },
    Prefs: {
      set(...args) {
        prefWrites.push(args);
      },
    },
    debug(message) {
      debugMessages.push(message);
    },
  };

  const modulePath = require.resolve("../chrome/content/preferences.js");
  delete require.cache[modulePath];
  try {
    const controller = require(modulePath);
    assert.equal(global.window.ZoteroMathPatchPreferences, controller);

    await controller.init();
    assert.equal(elements.apiKey.value, "stored-secret");

    elements.apiKey.value = "new-secret";
    const pendingTest = elements.testButton.emit("command");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(elements.testButton.disabled, true);
    assert.equal(elements.status.textContent, "Testing connection...");
    assert.equal(elements.status.dataset.state, "pending");
    assert.equal(capturedConfig.apiKey, "new-secret");
    assert.equal(capturedConfig.baseURL, "https://api.example.com/v1");

    resolveConnection({ ok: true, model: "deepseek-chat" });
    await pendingTest;
    assert.equal(elements.testButton.disabled, false);
    assert.equal(elements.status.textContent, "Connection successful (deepseek-chat).");
    assert.equal(elements.status.dataset.state, "success");
    assert.equal(savedKeys.at(-1), "new-secret");

    elements["zotero-math-patch-timeout"].value = "10000";
    connectionPromise = Promise.resolve({ ok: true, model: "deepseek-v4-flash" });
    await controller.testConnection();
    assert.equal(
      elements.status.textContent,
      "Connection successful (deepseek-v4-flash), but the 10 seconds request timeout may be too short for note processing.",
    );
    assert.equal(elements.status.dataset.state, "warning");

    await elements.resetButton.emit("command");
    assert.deepEqual(prefWrites.at(-1), [
      "extensions.zotero.mathPatch.systemPrompt",
      "default prompt",
      true,
    ]);

    connectionPromise = Promise.reject(Object.assign(new Error("Authentication failed."), {
      name: "AIProviderError",
      code: "authentication_failed",
    }));
    await controller.testConnection();
    assert.equal(elements.status.textContent, "Authentication failed.");
    assert.equal(elements.status.dataset.state, "error");
    assert.equal(elements.testButton.disabled, false);
    assert.match(debugMessages.at(-1), /authentication_failed/);
    assert.doesNotMatch(debugMessages.join("\n"), /new-secret|stored-secret/);
  }
  finally {
    delete require.cache[modulePath];
    restoreGlobals(originals);
  }

  console.log("preference pane tests passed");
};

class FakeElement {
  constructor(value = "") {
    this.value = value;
    this.disabled = false;
    this.textContent = "";
    this.dataset = {};
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async emit(type) {
    const results = (this.listeners.get(type) || []).map((listener) => listener({ type, target: this }));
    await Promise.all(results);
  }
}

function createElements() {
  return {
    "zotero-math-patch-api-key": new FakeElement(),
    "zotero-math-patch-connection-status": new FakeElement(),
    "zotero-math-patch-test-connection": new FakeElement(),
    "zotero-math-patch-reset-prompt": new FakeElement(),
    "zotero-math-patch-provider-type": new FakeElement("openai-compatible"),
    "zotero-math-patch-base-url": new FakeElement("https://api.example.com/v1"),
    "zotero-math-patch-model": new FakeElement("deepseek-chat"),
    "zotero-math-patch-timeout": new FakeElement("60000"),
    "zotero-math-patch-max-output-tokens": new FakeElement("2048"),
    get apiKey() {
      return this["zotero-math-patch-api-key"];
    },
    get status() {
      return this["zotero-math-patch-connection-status"];
    },
    get testButton() {
      return this["zotero-math-patch-test-connection"];
    },
    get resetButton() {
      return this["zotero-math-patch-reset-prompt"];
    },
  };
}

function captureGlobals(names) {
  return Object.fromEntries(names.map((name) => [
    name,
    {
      exists: Object.prototype.hasOwnProperty.call(global, name),
      value: global[name],
    },
  ]));
}

function restoreGlobals(originals) {
  for (const [name, original] of Object.entries(originals)) {
    if (original.exists) {
      global[name] = original.value;
    }
    else {
      delete global[name];
    }
  }
}
