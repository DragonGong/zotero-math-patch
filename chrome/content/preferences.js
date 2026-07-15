(function (global) {
  "use strict";

  const ZoteroMathPatchPreferences = {
    initialized: false,

    async init() {
      if (this.initialized) {
        return;
      }

      this.apiKeyInput = document.getElementById("zotero-math-patch-api-key");
      this.status = document.getElementById("zotero-math-patch-connection-status");
      this.testButton = document.getElementById("zotero-math-patch-test-connection");
      this.resetButton = document.getElementById("zotero-math-patch-reset-prompt");
      if (!this.apiKeyInput || !this.status || !this.testButton || !this.resetButton) {
        return;
      }

      this.initialized = true;
      this.apiKeyInput.addEventListener("change", () => this.storeAPIKey());
      this.testButton.addEventListener("command", () => this.testConnection());
      this.resetButton.addEventListener("command", () => this.restoreDefaultPrompt());

      try {
        this.apiKeyInput.value = await Zotero.MathPatch.getAPIKey();
      }
      catch (_error) {
        this.setStatus("Local credential storage is unavailable.", "error");
      }
    },

    async storeAPIKey() {
      try {
        await Zotero.MathPatch.setAPIKey(this.apiKeyInput.value);
      }
      catch (_error) {
        this.setStatus("Could not store the API Key locally.", "error");
      }
    },

    restoreDefaultPrompt() {
      Zotero.Prefs.set(
        "extensions.zotero.mathPatch.systemPrompt",
        Zotero.MathPatch.getDefaultSystemPrompt(),
        true,
      );
      this.setStatus("Default prompt restored.", "success");
    },

    async testConnection() {
      this.testButton.disabled = true;
      this.setStatus("Testing connection...", "pending");
      try {
        await Zotero.MathPatch.setAPIKey(this.apiKeyInput.value);
        const config = this.collectConfig();
        const result = await Zotero.MathPatch.testAIConnection(config);
        if (Number.isFinite(config.timeoutMs) && config.timeoutMs < 60000) {
          this.setStatus(
            `Connection successful (${result.model}), but the ${formatDuration(config.timeoutMs)} request timeout may be too short for note processing.`,
            "warning",
          );
        }
        else {
          this.setStatus(`Connection successful (${result.model}).`, "success");
        }
      }
      catch (error) {
        Zotero.debug(
          "Zotero Math Patch connection test failed: "
            + String(error?.code || error?.name || "unknown_error"),
        );
        const safeMessage = error?.name === "AIProviderError"
          ? error.message
          : "Connection test failed. Check the interface settings.";
        this.setStatus(safeMessage, "error");
      }
      finally {
        this.testButton.disabled = false;
      }
    },

    collectConfig() {
      return {
        providerType: document.getElementById("zotero-math-patch-provider-type").value,
        baseURL: document.getElementById("zotero-math-patch-base-url").value,
        apiKey: this.apiKeyInput.value,
        model: document.getElementById("zotero-math-patch-model").value,
        timeoutMs: Number.parseInt(document.getElementById("zotero-math-patch-timeout").value, 10),
        maxOutputTokens: Number.parseInt(
          document.getElementById("zotero-math-patch-max-output-tokens").value,
          10,
        ),
      };
    },

    setStatus(message, state) {
      if (!this.status) {
        return;
      }
      this.status.textContent = message;
      this.status.dataset.state = state;
    },
  };

  function formatDuration(milliseconds) {
    if (milliseconds % 1000 === 0) {
      return `${milliseconds / 1000} second${milliseconds === 1000 ? "" : "s"}`;
    }
    return `${milliseconds} ms`;
  }

  global.ZoteroMathPatchPreferences = ZoteroMathPatchPreferences;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ZoteroMathPatchPreferences;
  }
})(typeof window !== "undefined" ? window : globalThis);
