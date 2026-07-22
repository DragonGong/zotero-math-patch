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
      this.loggingCheckbox = document.getElementById("zotero-math-patch-logging-enabled");
      this.logDirectoryInput = document.getElementById("zotero-math-patch-log-directory");
      this.logDirectoryStatus = document.getElementById("zotero-math-patch-log-directory-status");
      this.chooseLogDirectoryButton = document.getElementById("zotero-math-patch-choose-log-directory");
      this.openLogDirectoryButton = document.getElementById("zotero-math-patch-open-log-directory");
      this.resetLogDirectoryButton = document.getElementById("zotero-math-patch-reset-log-directory");
      if (!this.apiKeyInput || !this.status || !this.testButton || !this.resetButton
        || !this.loggingCheckbox || !this.logDirectoryInput || !this.logDirectoryStatus
        || !this.chooseLogDirectoryButton || !this.openLogDirectoryButton
        || !this.resetLogDirectoryButton) {
        return;
      }

      this.initialized = true;
      this.apiKeyInput.addEventListener("change", () => this.storeAPIKey());
      this.testButton.addEventListener("command", () => this.testConnection());
      this.resetButton.addEventListener("command", () => this.restoreDefaultPrompt());
      this.chooseLogDirectoryButton.addEventListener("command", () => this.chooseLogDirectory());
      this.openLogDirectoryButton.addEventListener("command", () => this.openLogDirectory());
      this.resetLogDirectoryButton.addEventListener("command", () => this.resetLogDirectory());
      this.loggingCheckbox.addEventListener("command", () => this.refreshLogDirectory());

      try {
        this.apiKeyInput.value = await Zotero.MathPatch.getAPIKey();
      }
      catch (_error) {
        this.setStatus("Local credential storage is unavailable.", "error");
      }
      await this.refreshLogDirectory();
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
        let message;
        let state;
        if (Number.isFinite(config.timeoutMs) && config.timeoutMs < 60000) {
          message = `Connection successful (${result.model}), but the ${formatDuration(config.timeoutMs)} request timeout may be too short for note processing.`;
          state = "warning";
        }
        else {
          message = `Connection successful (${result.model}).`;
          state = "success";
        }
        if (result.logWarning) {
          message = appendLoggingWarning(message, result.logWarning);
          state = "warning";
        }
        this.setStatus(message, state);
      }
      catch (error) {
        Zotero.debug(
          "Zotero Math Patch connection test failed: "
            + String(error?.code || error?.name || "unknown_error"),
        );
        const safeMessage = error?.name === "AIProviderError"
          ? error.message
          : "Connection test failed. Check the interface settings.";
        this.setStatus(appendLoggingWarning(safeMessage, error?.logWarning), "error");
      }
      finally {
        this.testButton.disabled = false;
      }
    },

    async refreshLogDirectory() {
      try {
        const info = await Zotero.MathPatch.getLogDirectoryInfo();
        this.showLogDirectoryInfo(info);
        return info;
      }
      catch (_error) {
        this.setLogDirectoryStatus("The log directory is unavailable.", "error");
        return null;
      }
    },

    async chooseLogDirectory() {
      this.setLogDirectoryButtonsDisabled(true);
      try {
        const info = await Zotero.MathPatch.chooseLogDirectory();
        if (info) {
          this.showLogDirectoryInfo(info, "Log directory updated.");
        }
      }
      catch (_error) {
        this.setLogDirectoryStatus("The selected log directory could not be used.", "error");
      }
      finally {
        this.setLogDirectoryButtonsDisabled(false);
      }
    },

    async openLogDirectory() {
      this.setLogDirectoryButtonsDisabled(true);
      try {
        const info = await Zotero.MathPatch.openLogDirectory();
        this.showLogDirectoryInfo(info, "Log directory opened.");
      }
      catch (_error) {
        this.setLogDirectoryStatus("The log directory could not be opened.", "error");
      }
      finally {
        this.setLogDirectoryButtonsDisabled(false);
      }
    },

    async resetLogDirectory() {
      this.setLogDirectoryButtonsDisabled(true);
      try {
        const info = await Zotero.MathPatch.resetLogDirectory();
        this.showLogDirectoryInfo(info, "Default log directory restored.");
      }
      catch (_error) {
        this.setLogDirectoryStatus("The default log directory could not be restored.", "error");
      }
      finally {
        this.setLogDirectoryButtonsDisabled(false);
      }
    },

    showLogDirectoryInfo(info, successMessage = "") {
      if (this.logDirectoryInput) {
        this.logDirectoryInput.value = String(info?.path || "");
      }
      if (info?.warning) {
        this.setLogDirectoryStatus(info.warning, "warning");
      }
      else {
        const location = info?.isDefault ? "default profile directory" : "custom directory";
        this.setLogDirectoryStatus(successMessage || `Using the ${location}.`, "success");
      }
    },

    setLogDirectoryStatus(message, state) {
      if (!this.logDirectoryStatus) {
        return;
      }
      this.logDirectoryStatus.textContent = message;
      this.logDirectoryStatus.dataset.state = state;
    },

    setLogDirectoryButtonsDisabled(disabled) {
      this.chooseLogDirectoryButton.disabled = disabled;
      this.openLogDirectoryButton.disabled = disabled;
      this.resetLogDirectoryButton.disabled = disabled;
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

  function appendLoggingWarning(message, warning) {
    const detail = String(warning || "").trim();
    return detail ? `${message} Logging warning: ${detail}` : message;
  }

  global.ZoteroMathPatchPreferences = ZoteroMathPatchPreferences;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ZoteroMathPatchPreferences;
  }
})(typeof window !== "undefined" ? window : globalThis);
