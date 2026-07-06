(function (global) {
  "use strict";

  const MENU_ID = "zotero-math-patch-render-markdown-math";
  const NOTE_WINDOW_TYPE = "zotero:note";
  const registeredWindows = new Map();

  const ZoteroMathPatch = {
    async startup() {
      this.registerOpenWindows();
      setTimeout(() => this.registerOpenWindows(), 1000);
      setTimeout(() => this.registerOpenWindows(), 3000);
      Services.wm.addListener(windowListener);
    },

    shutdown() {
      Services.wm.removeListener(windowListener);
      for (const win of Array.from(registeredWindows.keys())) {
        this.onWindowUnload(win);
      }
    },

    onWindowLoad(win) {
      if (!win?.document) {
        return;
      }

      const windowType = win.document.documentElement.getAttribute("windowtype");
      if (windowType === NOTE_WINDOW_TYPE) {
        addMenuItemWithRetry(win, "menu_EditPopup");
        return;
      }

      addMenuItemWithRetry(win, "menu_ToolsPopup");
    },

    onWindowUnload(win) {
      const data = registeredWindows.get(win);
      if (!data) {
        return;
      }

      data.popup?.removeEventListener("popupshowing", data.onShowing);
      data.item?.removeEventListener("command", data.onCommand);
      data.separator?.remove();
      data.item?.remove();
      registeredWindows.delete(win);
    },

    registerOpenWindows() {
      const windows = new Set();
      const mainWindows = Zotero.getMainWindows?.() || [];
      for (const win of mainWindows) {
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
        await target.item.saveTx({
          notifierData: {
            autoSyncDelay: Zotero.Notes.AUTO_SYNC_DELAY,
          },
        });

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
  };

  const windowListener = {
    onOpenWindow(xulWindow) {
      const win = xulWindow
        .QueryInterface(Components.interfaces.nsIInterfaceRequestor)
        .getInterface(Components.interfaces.nsIDOMWindow);

      win.addEventListener(
        "load",
        () => ZoteroMathPatch.onWindowLoad(win),
        { once: true },
      );
    },
    onCloseWindow(xulWindow) {
      const win = xulWindow
        .QueryInterface(Components.interfaces.nsIInterfaceRequestor)
        .getInterface(Components.interfaces.nsIDOMWindow);
      ZoteroMathPatch.onWindowUnload(win);
    },
  };

  function addMenuItemWithRetry(win, popupID, attempts = 10) {
    if (addMenuItem(win, popupID)) {
      return;
    }

    if (attempts > 0) {
      setTimeout(() => addMenuItemWithRetry(win, popupID, attempts - 1), 500);
    }
  }

  function addMenuItem(win, popupID) {
    if (registeredWindows.has(win)) {
      return true;
    }

    const doc = win.document;
    const popup = doc.getElementById(popupID);
    if (!popup || doc.getElementById(MENU_ID)) {
      return !!doc.getElementById(MENU_ID);
    }

    const separator = doc.createXULElement("menuseparator");
    separator.id = MENU_ID + "-separator";

    const item = doc.createXULElement("menuitem");
    item.id = MENU_ID;
    item.setAttribute("label", "Render Markdown Math");

    const onCommand = () => ZoteroMathPatch.renderCurrentNote(win);
    const onShowing = async () => {
      const target = await getCurrentNoteTarget(win);
      item.disabled = !target?.item || !target.item.isEditable();
    };

    item.addEventListener("command", onCommand);
    popup.addEventListener("popupshowing", onShowing);
    popup.appendChild(separator);
    popup.appendChild(item);

    registeredWindows.set(win, {
      popup,
      separator,
      item,
      onCommand,
      onShowing,
    });
    return true;
  }

  async function getCurrentNoteTarget(win) {
    const noteEditorElement = win.document?.getElementById("zotero-note-editor");
    if (noteEditorElement) {
      await noteEditorElement._initPromise;
      const editor = noteEditorElement.getCurrentInstance?.() || noteEditorElement._editorInstance;
      if (isUsableNoteEditor(editor)) {
        return {
          editor,
          item: editor._item,
        };
      }
    }

    const selectedTabID = win.Zotero_Tabs?.selectedID;
    if (selectedTabID) {
      const editor = Zotero.Notes.getByTabID(selectedTabID);
      if (isUsableNoteEditor(editor)) {
        return {
          editor,
          item: editor._item,
        };
      }

      const tabInfo = win.Zotero_Tabs.getTabInfo?.(selectedTabID);
      const itemID = tabInfo?.data?.itemID;
      const item = itemID ? Zotero.Items.get(itemID) : null;
      if (item?.isNote()) {
        return {
          editor: findOpenEditorForItem(item),
          item,
        };
      }
    }

    const selectedItems = win.ZoteroPane?.getSelectedItems?.() || [];
    if (selectedItems.length === 1 && selectedItems[0].isNote()) {
      const item = selectedItems[0];
      return {
        editor: findOpenEditorForItem(item),
        item,
      };
    }

    return null;
  }

  function getCurrentNoteItem(win) {
    const noteEditorElement = win?.document?.getElementById("zotero-note-editor");
    const editor = noteEditorElement?.getCurrentInstance?.()
      || noteEditorElement?._editorInstance
      || Zotero.Notes.getByTabID(win?.Zotero_Tabs?.selectedID);
    if (isUsableNoteEditor(editor)) {
      return editor._item;
    }

    const tabInfo = win?.Zotero_Tabs?.getTabInfo?.(win.Zotero_Tabs.selectedID);
    const itemID = tabInfo?.data?.itemID;
    const tabItem = itemID ? Zotero.Items.get(itemID) : null;
    if (tabItem?.isNote()) {
      return tabItem;
    }

    const selectedItems = win?.ZoteroPane?.getSelectedItems?.() || [];
    if (selectedItems.length === 1 && selectedItems[0].isNote()) {
      return selectedItems[0];
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
        Zotero.debug("Zotero Math Patch: failed to read live editor HTML: " + error);
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

  function refreshOpenEditors(item, html) {
    for (const editor of Zotero.Notes._editorInstances) {
      if (isUsableNoteEditor(editor) && editor._item.id === item.id) {
        editor.applyIncrementalUpdate({ html }, true);
      }
    }
  }

  function showMessage(win, title, message) {
    Services.prompt.alert(win || null, title, message);
  }

  global.ZoteroMathPatch = ZoteroMathPatch;
  Zotero.MathPatch = ZoteroMathPatch;
})(typeof globalThis !== "undefined" ? globalThis : this);
