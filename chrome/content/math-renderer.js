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

    async startup() {
      const credentialStore = global.ZoteroMathPatchCredentials.createCredentialStore(
        Services,
        Components,
      );
      this.settingsStore = global.ZoteroMathPatchSettings.createSettingsStore(
        Zotero.Prefs,
        credentialStore,
      );
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
    },

    shutdown() {
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
      try {
        const target = await getCurrentNoteTarget(win);
        if (!target?.item) {
          showMessage(win, "Render Markdown Math", "No current Zotero note found.");
          return;
        }
        if (!target.item.isEditable()) {
          showMessage(win, "Render Markdown Math", "The current note is read-only.");
          return;
        }

        const originalHTML = getCurrentHTML(target);
        const { html, stats } = global.ZoteroMathPatchConverter.renderMarkdownMathInHTML(originalHTML);
        if (!stats.changed || html === originalHTML) {
          showMessage(win, "Render Markdown Math", "No Markdown math delimiters found.");
          return;
        }

        target.item.setNote(html);
        await saveNoteItem(target.item);
        refreshOpenEditors(target.item, html);
        showMessage(
          win,
          "Render Markdown Math",
          `Rendered ${stats.block} block and ${stats.inline} inline formula(s).`,
        );
      }
      catch (error) {
        Zotero.logError(error);
        showMessage(win, "Render Markdown Math", String(error));
      }
    },

    async processCurrentNoteWithAI(win) {
      let target;
      let provider;
      let originalHTML = "";
      let itemID = null;
      try {
        target = await getCurrentNoteTarget(win);
        if (!target?.item) {
          showMessage(win, "Process Math with AI", "No current Zotero note found.");
          return;
        }
        if (!target.item.isEditable()) {
          showMessage(win, "Process Math with AI", "The current note is read-only.");
          return;
        }

        itemID = target.item.id;
        if (processingItems.has(itemID)) {
          showMessage(win, "Process Math with AI", "This note is already being processed.");
          return;
        }

        const settings = this.settingsStore.getAll();
        if (settings.processingScope === global.ZoteroMathPatchSettings.SCOPE_SELECTION) {
          showMessage(
            win,
            "Process Math with AI",
            "Selected-content processing is not available yet. Choose whole note or selection-first fallback in Math Patch settings.",
          );
          return;
        }
        if (!this.settingsStore.isConfigured(settings)) {
          promptToOpenSettings(win);
          return;
        }

        processingItems.add(itemID);
        updateMenuStateForAllWindows();
        originalHTML = getCurrentHTML(target);
        const apiKey = await this.settingsStore.getAPIKey();
        provider = global.ZoteroMathPatchAIProvider.createProvider(
          settings.providerType,
          { ...settings, apiKey },
          {
            fetchImpl: global.fetch,
            AbortControllerImpl: global.AbortController,
            setTimeoutImpl: global.setTimeout,
            clearTimeoutImpl: global.clearTimeout,
          },
        );
        activeProviders.add(provider);

        const result = await global.ZoteroMathPatchAIWorkflow.processNoteWithAI({
          originalHTML,
          settings,
          provider,
          core: global.ZoteroMathPatchAICore,
          confirmPreview: ({ operations, stats }) => showPreviewDialog(win, operations, stats),
          getCurrentHTML: () => getCurrentHTML(target),
          save: async (html) => {
            target.item.setNote(html);
            try {
              await saveNoteItem(target.item);
            }
            catch (_error) {
              target.item.setNote(originalHTML);
              throw runtimeError("save_failed", "Zotero could not save the processed note. The original note was restored.");
            }
            refreshOpenEditors(target.item, html);
          },
        });

        if (result.status === "saved") {
          showMessage(
            win,
            "Process Math with AI",
            `Saved ${result.stats.inline} inline and ${result.stats.block} block formula(s) using ${settings.model}.`,
          );
        }
        else if (result.status === "cancelled") {
          showMessage(win, "Process Math with AI", "Cancelled. The note was not modified.");
        }
        else if (result.status === "no_text") {
          showMessage(win, "Process Math with AI", "No processable note text was found.");
        }
        else {
          showMessage(win, "Process Math with AI", "No damaged formulas were found. The note was not modified.");
        }
      }
      catch (error) {
        const code = String(error?.code || error?.name || "unknown_error");
        Zotero.debug("Zotero Math Patch AI request failed: " + code);
        showMessage(win, "Process Math with AI", getSafeAIErrorMessage(error));
      }
      finally {
        if (provider) {
          activeProviders.delete(provider);
        }
        if (itemID !== null) {
          processingItems.delete(itemID);
          updateMenuStateForAllWindows();
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

    async testAIConnection(config) {
      const stored = this.settingsStore.getAll();
      const merged = {
        ...stored,
        ...(config || {}),
      };
      const apiKey = config && Object.prototype.hasOwnProperty.call(config, "apiKey")
        ? String(config.apiKey || "")
        : await this.settingsStore.getAPIKey();
      const provider = global.ZoteroMathPatchAIProvider.createProvider(
        merged.providerType,
        { ...merged, apiKey },
        {
          fetchImpl: global.fetch,
          AbortControllerImpl: global.AbortController,
          setTimeoutImpl: global.setTimeout,
          clearTimeoutImpl: global.clearTimeout,
        },
      );
      activeProviders.add(provider);
      try {
        return await provider.testConnection();
      }
      finally {
        activeProviders.delete(provider);
      }
    },
  };

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
    for (const editor of Zotero.Notes._editorInstances) {
      if (isUsableNoteEditor(editor) && editor._item.id === item.id) {
        editor.applyIncrementalUpdate({ html }, true);
      }
    }
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
