(function (global) {
  "use strict";

  const RULE_MENU_ID = "zotero-math-patch-render-markdown-math";
  const AI_MENU_ID = "zotero-math-patch-process-math-with-ai";
  const NOTE_WINDOW_TYPE = "zotero:note";
  const registeredWindows = new Map();
  const processingItems = new Set();
  const activeProviders = new Set();

  const ZoteroMathPatch = {
    preferencePaneID: null,
    settingsStore: null,
    logManager: null,

    async startup() {
      const credentialStore = global.ZoteroMathPatchCredentials.createCredentialStore(
        Services,
        Components,
      );
      this.settingsStore = global.ZoteroMathPatchSettings.createSettingsStore(
        Zotero.Prefs,
        credentialStore,
      );
      this.logManager = createRuntimeLogManager(this.settingsStore);
      const trace = await this.startTrace("startup");

      try {
        this.preferencePaneID = await Zotero.PreferencePanes.register({
          pluginID,
          id: global.ZoteroMathPatchSettings.PREF_PANE_ID,
          label: "Math Patch",
          image: "chrome://zotero/skin/20/universal/cog.svg",
          src: "chrome/content/preferences.xhtml",
          scripts: ["chrome/content/preferences.js"],
          stylesheets: ["chrome/content/preferences.css"],
        });

        this.registerOpenWindows();
        setTimeout(() => this.registerOpenWindows(), 1000);
        setTimeout(() => this.registerOpenWindows(), 3000);
        Services.wm.addListener(windowListener);
        await safeTrace(trace, "lifecycle_started", {
          preferencePaneID: this.preferencePaneID,
          registeredWindowCount: registeredWindows.size,
        });
        await safeFinish(trace, "success");
      }
      catch (error) {
        await safeTrace(trace, "lifecycle_error", { error });
        await safeFinish(trace, "error", { error });
        throw error;
      }
    },

    async shutdown() {
      const trace = await this.startTrace("shutdown", {
        activeProviderCount: activeProviders.size,
        registeredWindowCount: registeredWindows.size,
      });
      try {
        Services.wm.removeListener(windowListener);
        for (const provider of activeProviders) {
          provider.cancel();
        }
        activeProviders.clear();
        for (const win of Array.from(registeredWindows.keys())) {
          this.onWindowUnload(win);
        }
        if (this.preferencePaneID) {
          Zotero.PreferencePanes.unregister(this.preferencePaneID);
          this.preferencePaneID = null;
        }
        await safeTrace(trace, "lifecycle_stopped", {});
        await safeFinish(trace, "success");
      }
      catch (error) {
        await safeTrace(trace, "lifecycle_error", { error });
        await safeFinish(trace, "error", { error });
        throw error;
      }
    },

    async startTrace(feature, initialData = {}) {
      try {
        let initialSecrets = [];
        if (this.settingsStore?.get("loggingEnabled") !== false) {
          try {
            initialSecrets = [await this.settingsStore.getAPIKey()];
          }
          catch (_error) {}
        }
        return await this.logManager.startRun(feature, initialData, initialSecrets);
      }
      catch (error) {
        reportLoggerError(error);
        return global.ZoteroMathPatchLogger.createNoopTrace(
          "Diagnostic logging could not be started.",
        );
      }
    },

    onWindowLoad(win) {
      if (!win?.document) {
        return;
      }
      const windowType = win.document.documentElement.getAttribute("windowtype");
      addMenuItemsWithRetry(
        win,
        windowType === NOTE_WINDOW_TYPE ? "menu_EditPopup" : "menu_ToolsPopup",
      );
    },

    onWindowUnload(win) {
      const data = registeredWindows.get(win);
      if (!data) {
        return;
      }
      data.popup?.removeEventListener("popupshowing", data.onShowing);
      data.ruleItem?.removeEventListener("command", data.onRuleCommand);
      data.aiItem?.removeEventListener("command", data.onAICommand);
      data.separator?.remove();
      data.ruleItem?.remove();
      data.aiItem?.remove();
      registeredWindows.delete(win);
    },

    registerOpenWindows() {
      const windows = new Set();
      for (const win of Zotero.getMainWindows?.() || []) {
        windows.add(win);
      }
      const mainWindow = Zotero.getMainWindow?.();
      if (mainWindow) {
        windows.add(mainWindow);
      }
      const noteWindows = Services.wm.getEnumerator(NOTE_WINDOW_TYPE);
      while (noteWindows.hasMoreElements()) {
        windows.add(noteWindows.getNext());
      }
      for (const win of windows) {
        this.onWindowLoad(win);
      }
    },

    async renderCurrentNote(win) {
      const trace = await this.startTrace("render-markdown-math");
      let outcome = {
        status: "error",
        message: "Markdown math rendering failed.",
      };
      try {
        const target = await getCurrentNoteTarget(win);
        await safeTrace(trace, "target_resolved", { target: describeTarget(target) });
        if (!target?.item) {
          outcome = { status: "no_note", message: "No current Zotero note found." };
        }
        else if (!target.item.isEditable()) {
          outcome = { status: "read_only", message: "The current note is read-only." };
        }
        else {
          const originalHTML = getCurrentHTML(target);
          await safeTrace(trace, "note_input", {
            target: describeTarget(target),
            originalHTML,
          });
          const { html, stats } = global.ZoteroMathPatchConverter.renderMarkdownMathInHTML(originalHTML);
          await safeTrace(trace, "conversion_completed", {
            originalHTML,
            finalHTML: html,
            stats,
          });
          if (!stats.changed || html === originalHTML) {
            outcome = {
              status: "no_formulas",
              message: "No Markdown math delimiters found.",
              stats,
            };
          }
          else {
            target.item.setNote(html);
            await safeTrace(trace, "save_started", { finalHTML: html });
            await saveNoteItem(target.item);
            await safeTrace(trace, "save_completed", { finalHTML: html });
            const refreshedEditorCount = refreshOpenEditors(target.item, html);
            await safeTrace(trace, "editors_refreshed", { refreshedEditorCount });
            outcome = {
              status: "saved",
              message: `Rendered ${stats.block} block and ${stats.inline} inline formula(s).`,
              stats,
              saved: true,
            };
          }
        }
      }
      catch (error) {
        Zotero.logError(error);
        await safeTrace(trace, "operation_error", { error });
        outcome = {
          status: "error",
          message: String(error),
          error,
        };
      }
      finally {
        await safeFinish(trace, outcome.status, outcome);
        showMessage(
          win,
          "Render Markdown Math",
          appendLogWarning(outcome.message, trace.getWarning?.()),
        );
      }
    },

    async processCurrentNoteWithAI(win) {
      const trace = await this.startTrace("process-math-with-ai");
      let target;
      let provider;
      let progressIndicator;
      let originalHTML = "";
      let itemID = null;
      let outcome = {
        status: "error",
        message: "AI processing failed. The note was not modified.",
      };
      try {
        target = await getCurrentNoteTarget(win);
        await safeTrace(trace, "target_resolved", { target: describeTarget(target) });
        if (!target?.item) {
          outcome = { status: "no_note", message: "No current Zotero note found." };
        }
        else if (!target.item.isEditable()) {
          outcome = { status: "read_only", message: "The current note is read-only." };
        }
        else {
          itemID = target.item.id;
          if (processingItems.has(itemID)) {
            outcome = {
              status: "already_processing",
              message: "This note is already being processed.",
            };
          }
          else {
            const settings = this.settingsStore.getAll();
            await safeTrace(trace, "settings_loaded", { settings });
            if (settings.processingScope === global.ZoteroMathPatchSettings.SCOPE_SELECTION) {
              outcome = {
                status: "unsupported_scope",
                message: "Selected-content processing is not available yet. Choose whole note or selection-first fallback in Math Patch settings.",
              };
            }
            else if (!this.settingsStore.isConfigured(settings)) {
              await safeTrace(trace, "configuration_missing", { settings });
              promptToOpenSettings(win);
              outcome = {
                status: "not_configured",
                message: "The model service is not configured.",
                showMessage: false,
              };
            }
            else {
              processingItems.add(itemID);
              updateMenuStateForAllWindows();
              progressIndicator = createAIProgressIndicator(win, trace);
              originalHTML = getCurrentHTML(target);
              await safeTrace(trace, "note_input", {
                target: describeTarget(target),
                originalHTML,
              });
              const apiKey = await this.settingsStore.getAPIKey();
              safeAddSecret(trace, apiKey);
              await safeTrace(trace, "provider_configured", {
                config: { ...settings, apiKey },
              });
              provider = global.ZoteroMathPatchAIProvider.createProvider(
                settings.providerType,
                { ...settings, apiKey },
                createProviderDependencies(),
              );
              activeProviders.add(provider);

              const result = await global.ZoteroMathPatchAIWorkflow.processNoteWithAI({
                originalHTML,
                settings,
                provider,
                trace,
                core: global.ZoteroMathPatchAICore,
                onProgress: (event) => {
                  progressIndicator?.update?.(event);
                  if (event?.phase === "preview_ready") {
                    progressIndicator?.close?.();
                  }
                },
                confirmPreview: ({ operations, stats }) => showPreviewDialog(win, operations, stats),
                getCurrentHTML: () => getCurrentHTML(target),
                save: async (html) => {
                  target.item.setNote(html);
                  try {
                    await saveNoteItem(target.item);
                  }
                  catch (error) {
                    target.item.setNote(originalHTML);
                    await safeTrace(trace, "save_rollback", {
                      restoredOriginalHTML: true,
                      originalHTML,
                      attemptedHTML: html,
                      error,
                    });
                    throw runtimeError(
                      "save_failed",
                      "Zotero could not save the processed note. The original note was restored.",
                    );
                  }
                  const refreshedEditorCount = refreshOpenEditors(target.item, html);
                  await safeTrace(trace, "editors_refreshed", { refreshedEditorCount });
                },
              });
              await safeTrace(trace, "workflow_result", { result });

              if (result.status === "saved") {
                const ignoredMessage = getIgnoredOperationMessage(result);
                outcome = {
                  status: "saved",
                  message: `Saved ${result.stats.inline} inline and ${result.stats.block} block formula(s) using ${settings.model}.${ignoredMessage}`,
                  result,
                };
              }
              else if (result.status === "cancelled") {
                outcome = {
                  status: "cancelled",
                  message: "Cancelled. The note was not modified.",
                  result,
                };
              }
              else if (result.status === "no_text") {
                outcome = {
                  status: "no_text",
                  message: "No processable note text was found.",
                  result,
                };
              }
              else {
                const ignoredMessage = getIgnoredOperationMessage(result);
                outcome = {
                  status: "no_formulas",
                  message: `No damaged formulas were found. The note was not modified.${ignoredMessage}`,
                  result,
                };
              }
            }
          }
        }
      }
      catch (error) {
        const code = String(error?.code || error?.name || "unknown_error");
        Zotero.debug("Zotero Math Patch AI request failed: " + code);
        await safeTrace(trace, "operation_error", { error, originalHTML });
        outcome = {
          status: "error",
          message: getSafeAIErrorMessage(error),
          error,
        };
      }
      finally {
        progressIndicator?.close?.();
        if (provider) {
          activeProviders.delete(provider);
        }
        if (itemID !== null) {
          processingItems.delete(itemID);
          updateMenuStateForAllWindows();
        }
        await safeFinish(trace, outcome.status, outcome);
        const warning = trace.getWarning?.();
        if (outcome.showMessage !== false || warning) {
          showMessage(
            win,
            "Process Math with AI",
            appendLogWarning(outcome.message, warning),
          );
        }
      }
    },

    openPreferences() {
      Zotero.Utilities.Internal.openPreferences(global.ZoteroMathPatchSettings.PREF_PANE_ID);
    },

    getDefaultSystemPrompt() {
      return global.ZoteroMathPatchSettings.DEFAULT_SYSTEM_PROMPT;
    },

    async getAPIKey() {
      return this.settingsStore.getAPIKey();
    },

    async setAPIKey(apiKey) {
      await this.settingsStore.setAPIKey(apiKey);
    },

    async getLogDirectoryInfo() {
      return this.logManager.getDirectoryInfo();
    },

    async chooseLogDirectory() {
      const { FilePicker } = ChromeUtils.importESModule(
        "chrome://zotero/content/modules/filePicker.mjs",
      );
      const picker = new FilePicker();
      picker.init(
        Zotero.getMainWindow(),
        "Choose Math Patch Log Folder",
        picker.modeGetFolder,
      );
      const result = await picker.show();
      if (result === picker.returnCancel) {
        return null;
      }
      const selectedPath = String(picker.file?.path || picker.file || "").trim();
      if (!selectedPath) {
        throw runtimeError("log_directory_unavailable", "No log directory was selected.");
      }
      const previousPath = this.settingsStore.get("logDirectory");
      this.settingsStore.set("logDirectory", selectedPath);
      return this.logManager.directoryChanged(previousPath, selectedPath);
    },

    async resetLogDirectory() {
      const previousPath = this.settingsStore.get("logDirectory");
      this.settingsStore.set("logDirectory", "");
      return this.logManager.directoryChanged(previousPath, "");
    },

    async openLogDirectory() {
      const info = await this.logManager.getDirectoryInfo();
      await Zotero.File.reveal(info.path);
      return info;
    },

    async testAIConnection(config) {
      const trace = await this.startTrace("test-connection");
      let provider;
      try {
        const stored = this.settingsStore.getAll();
        const merged = {
          ...stored,
          ...(config || {}),
        };
        const apiKey = config && Object.prototype.hasOwnProperty.call(config, "apiKey")
          ? String(config.apiKey || "")
          : await this.settingsStore.getAPIKey();
        safeAddSecret(trace, apiKey);
        await safeTrace(trace, "connection_configuration", {
          config: { ...merged, apiKey },
        });
        provider = global.ZoteroMathPatchAIProvider.createProvider(
          merged.providerType,
          { ...merged, apiKey },
          createProviderDependencies(),
        );
        activeProviders.add(provider);
        const result = await provider.testConnection({ trace });
        await safeTrace(trace, "connection_result", { result });
        await safeFinish(trace, "success", { result });
        return {
          ...result,
          logWarning: trace.getWarning?.() || "",
        };
      }
      catch (error) {
        await safeTrace(trace, "connection_error", { error });
        await safeFinish(trace, "error", { error });
        try {
          error.logWarning = trace.getWarning?.() || "";
        }
        catch (_error) {}
        throw error;
      }
      finally {
        if (provider) {
          activeProviders.delete(provider);
        }
      }
    },
  };

  function createRuntimeLogManager(settingsStore) {
    try {
      return global.ZoteroMathPatchLogger.createLogManager({
        io: global.IOUtils,
        pathUtils: global.PathUtils,
        profileDir: global.PathUtils?.profileDir,
        getSettings: () => settingsStore.getAll(),
        historyStore: {
          get(name) {
            try {
              return Zotero.Prefs.get(name, true) || "[]";
            }
            catch (_error) {
              return "[]";
            }
          },
          set(name, value) {
            Zotero.Prefs.set(name, value, true);
          },
        },
        metadataProvider: () => ({
          pluginVersion: String(global.pluginVersion || "unknown"),
          zoteroVersion: String(Zotero.version || "unknown"),
          platform: String(Services.appinfo?.OS || "unknown"),
        }),
        randomID: () => Zotero.Utilities.randomString?.(10)
          || Math.random().toString(36).slice(2, 12),
        reportError: reportLoggerError,
      });
    }
    catch (error) {
      reportLoggerError(error);
      return createUnavailableLogManager();
    }
  }

  function createUnavailableLogManager() {
    const warning = "Diagnostic logging is unavailable in this Zotero environment.";
    return {
      async startRun() {
        return global.ZoteroMathPatchLogger.createNoopTrace(warning);
      },
      async getDirectoryInfo() {
        throw runtimeError("log_directory_unavailable", warning);
      },
      async directoryChanged() {
        throw runtimeError("log_directory_unavailable", warning);
      },
      async pruneExpiredLogs() {
        return { removed: 0 };
      },
    };
  }

  function createProviderDependencies() {
    return {
      fetchImpl: global.fetch,
      AbortControllerImpl: global.AbortController,
      setTimeoutImpl: global.setTimeout,
      clearTimeoutImpl: global.clearTimeout,
    };
  }

  function createAIProgressIndicator(win, trace) {
    const reportError = (error) => {
      Zotero.debug("Zotero Math Patch progress indicator failed: " + String(error?.name || "unknown_error"));
      safeTrace(trace, "progress_indicator_error", { error });
    };
    try {
      const factory = global.ZoteroMathPatchAIProgress?.createProgressIndicator;
      if (typeof factory !== "function") {
        throw new Error("The AI progress indicator module is unavailable.");
      }
      return factory({
        Zotero,
        window: win || Zotero.getMainWindow(),
        onError: reportError,
      });
    }
    catch (error) {
      reportError(error);
      return {
        update() {},
        close() {},
      };
    }
  }

  function reportLoggerError(error) {
    try {
      Zotero.debug(
        "Zotero Math Patch diagnostic logging error: "
          + String(error?.code || error?.name || "unknown_error"),
      );
    }
    catch (_error) {}
  }

  function describeTarget(target) {
    const item = target?.item;
    if (!item) {
      return null;
    }
    return {
      itemID: item.id ?? null,
      itemKey: item.key ?? null,
      libraryID: item.libraryID ?? null,
      editable: !!item.isEditable?.(),
      liveEditor: isUsableNoteEditor(target.editor),
    };
  }

  async function safeTrace(trace, eventName, data) {
    try {
      await trace?.event?.(eventName, data);
    }
    catch (_error) {}
  }

  function safeAddSecret(trace, secret) {
    try {
      trace?.addSecret?.(secret);
    }
    catch (_error) {}
  }

  async function safeFinish(trace, status, data = {}) {
    try {
      await trace?.finish?.(status, data);
    }
    catch (_error) {}
  }

  function appendLogWarning(message, warning) {
    const base = String(message || "");
    const detail = String(warning || "").trim();
    return detail ? `${base}\n\nLogging warning: ${detail}` : base;
  }

  function getIgnoredOperationMessage(result) {
    const messages = [];
    if (result?.ignoredProtectedOperations) {
      messages.push(
        `${result.ignoredProtectedOperations} operation(s) targeting existing formulas or protected content`,
      );
    }
    if (result?.ignoredRedundantOperations) {
      messages.push(
        `${result.ignoredRedundantOperations} redundant operation(s) already covered by another result`,
      );
    }
    return messages.length ? ` Ignored ${messages.join(" and ")}.` : "";
  }

  const windowListener = {
    onOpenWindow(xulWindow) {
      const win = xulWindow
        .QueryInterface(Components.interfaces.nsIInterfaceRequestor)
        .getInterface(Components.interfaces.nsIDOMWindow);
      win.addEventListener("load", () => ZoteroMathPatch.onWindowLoad(win), { once: true });
    },
    onCloseWindow(xulWindow) {
      const win = xulWindow
        .QueryInterface(Components.interfaces.nsIInterfaceRequestor)
        .getInterface(Components.interfaces.nsIDOMWindow);
      ZoteroMathPatch.onWindowUnload(win);
    },
  };

  function addMenuItemsWithRetry(win, popupID, attempts = 10) {
    if (addMenuItems(win, popupID)) {
      return;
    }
    if (attempts > 0) {
      setTimeout(() => addMenuItemsWithRetry(win, popupID, attempts - 1), 500);
    }
  }

  function addMenuItems(win, popupID) {
    if (registeredWindows.has(win)) {
      return true;
    }
    const doc = win.document;
    const popup = doc.getElementById(popupID);
    if (!popup) {
      return false;
    }
    if (doc.getElementById(RULE_MENU_ID) || doc.getElementById(AI_MENU_ID)) {
      return false;
    }

    const separator = doc.createXULElement("menuseparator");
    separator.id = RULE_MENU_ID + "-separator";
    const ruleItem = doc.createXULElement("menuitem");
    ruleItem.id = RULE_MENU_ID;
    ruleItem.setAttribute("label", "Render Markdown Math");
    const aiItem = doc.createXULElement("menuitem");
    aiItem.id = AI_MENU_ID;
    aiItem.setAttribute("label", "Process Math with AI");

    const onRuleCommand = () => ZoteroMathPatch.renderCurrentNote(win);
    const onAICommand = () => ZoteroMathPatch.processCurrentNoteWithAI(win);
    const onShowing = () => updateWindowMenuState(win);
    ruleItem.addEventListener("command", onRuleCommand);
    aiItem.addEventListener("command", onAICommand);
    popup.addEventListener("popupshowing", onShowing);
    popup.appendChild(separator);
    popup.appendChild(ruleItem);
    popup.appendChild(aiItem);

    registeredWindows.set(win, {
      popup,
      separator,
      ruleItem,
      aiItem,
      onRuleCommand,
      onAICommand,
      onShowing,
    });
    return true;
  }

  async function updateWindowMenuState(win) {
    const data = registeredWindows.get(win);
    if (!data) {
      return;
    }
    const target = await getCurrentNoteTarget(win);
    const editable = !!target?.item?.isEditable?.();
    const busy = editable && processingItems.has(target.item.id);
    data.ruleItem.disabled = !editable || busy;
    data.aiItem.disabled = !editable || busy;
  }

  function updateMenuStateForAllWindows() {
    for (const win of registeredWindows.keys()) {
      updateWindowMenuState(win).catch(() => {});
    }
  }

  async function getCurrentNoteTarget(win) {
    const noteEditorElement = win.document?.getElementById("zotero-note-editor");
    if (noteEditorElement) {
      await noteEditorElement._initPromise;
      const editor = noteEditorElement.getCurrentInstance?.() || noteEditorElement._editorInstance;
      if (isUsableNoteEditor(editor)) {
        return { editor, item: editor._item };
      }
    }

    const selectedTabID = win.Zotero_Tabs?.selectedID;
    if (selectedTabID) {
      const editor = Zotero.Notes.getByTabID(selectedTabID);
      if (isUsableNoteEditor(editor)) {
        return { editor, item: editor._item };
      }
      const tabInfo = win.Zotero_Tabs.getTabInfo?.(selectedTabID);
      const itemID = tabInfo?.data?.itemID;
      const item = itemID ? Zotero.Items.get(itemID) : null;
      if (item?.isNote()) {
        return { editor: findOpenEditorForItem(item), item };
      }
    }

    const selectedItems = win.ZoteroPane?.getSelectedItems?.() || [];
    if (selectedItems.length === 1 && selectedItems[0].isNote()) {
      const item = selectedItems[0];
      return { editor: findOpenEditorForItem(item), item };
    }
    return null;
  }

  function getCurrentHTML(target) {
    const editor = target.editor;
    if (isUsableNoteEditor(editor)) {
      try {
        const data = editor._iframeWindow.wrappedJSObject.getDataSync(true);
        if (data?.html !== undefined && data.html !== null) {
          return data.html;
        }
      }
      catch (error) {
        Zotero.debug("Zotero Math Patch: failed to read live editor HTML: " + error?.name);
      }
    }
    return target.item.getNote();
  }

  function findOpenEditorForItem(item) {
    return Zotero.Notes._editorInstances.find(
      (editor) => isUsableNoteEditor(editor) && editor._item?.id === item.id,
    );
  }

  function isUsableNoteEditor(editor) {
    if (!editor?._item?.isNote?.() || !editor._iframeWindow) {
      return false;
    }
    try {
      return !Components.utils.isDeadWrapper(editor._iframeWindow);
    }
    catch (_error) {
      return false;
    }
  }

  async function saveNoteItem(item) {
    await item.saveTx({
      notifierData: {
        autoSyncDelay: Zotero.Notes.AUTO_SYNC_DELAY,
      },
    });
  }

  function refreshOpenEditors(item, html) {
    let refreshedEditorCount = 0;
    for (const editor of Zotero.Notes._editorInstances) {
      if (isUsableNoteEditor(editor) && editor._item.id === item.id) {
        editor.applyIncrementalUpdate({ html }, true);
        refreshedEditorCount++;
      }
    }
    return refreshedEditorCount;
  }

  function promptToOpenSettings(win) {
    const prompt = Services.prompt;
    const flags = prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING
      + prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_CANCEL;
    const result = prompt.confirmEx(
      win || null,
      "Process Math with AI",
      "The model service is not configured. Open Math Patch settings now?",
      flags,
      "Open Settings",
      null,
      null,
      null,
      {},
    );
    if (result === 0) {
      ZoteroMathPatch.openPreferences();
    }
  }

  function showPreviewDialog(win, operations, stats) {
    const owner = win || Zotero.getMainWindow();
    if (!owner?.openDialog) {
      throw runtimeError("preview_unavailable", "The formula preview could not be opened. Nothing was saved.");
    }
    const io = {
      accepted: false,
      operations,
      stats,
    };
    owner.openDialog(
      "chrome://zotero-math-patch/content/preview.xhtml",
      "zotero-math-patch-preview",
      "chrome,modal,resizable,centerscreen,width=760,height=620",
      io,
    );
    return io.accepted === true;
  }

  function getSafeAIErrorMessage(error) {
    if (["AIProviderError", "AIValidationError", "MathPatchRuntimeError"].includes(error?.name)) {
      return error.message;
    }
    return "AI processing failed. The note was not modified.";
  }

  function runtimeError(code, message) {
    const error = new Error(message);
    error.name = "MathPatchRuntimeError";
    error.code = code;
    return error;
  }

  function showMessage(win, title, message) {
    Services.prompt.alert(win || null, title, message);
  }

  global.ZoteroMathPatch = ZoteroMathPatch;
  Zotero.MathPatch = ZoteroMathPatch;
})(typeof globalThis !== "undefined" ? globalThis : this);
