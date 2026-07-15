(function (global) {
  "use strict";

  const ZoteroMathPatchPreview = {
    initialized: false,
    io: null,

    init() {
      if (this.initialized) {
        return;
      }

      const argument = global.arguments?.[0];
      this.io = argument?.wrappedJSObject || argument || null;
      const operations = Array.isArray(this.io?.operations) ? this.io.operations : [];
      const stats = this.io?.stats || { inline: 0, block: 0 };
      const summary = global.document.getElementById("zotero-math-patch-preview-summary");
      const list = global.document.getElementById("zotero-math-patch-preview-list");
      const applyButton = global.document.getElementById("zotero-math-patch-preview-apply");
      const cancelButton = global.document.getElementById("zotero-math-patch-preview-cancel");
      if (!summary || !list || !applyButton || !cancelButton) {
        throw new Error("Math Patch preview controls could not be initialized.");
      }

      this.initialized = true;
      summary.textContent = `${stats.inline || 0} inline and ${stats.block || 0} block formula(s) detected.`;
      list.replaceChildren();

      operations.forEach((operation, index) => {
        const row = global.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
        row.className = "zotero-math-patch-preview-row";
        row.setAttribute("role", "listitem");
        appendText(global.document, row, "div", "zotero-math-patch-preview-kind", `${index + 1}. ${operation.type === "inline" ? "Inline" : "Block"}`);
        appendText(global.document, row, "div", "zotero-math-patch-preview-label", "Original");
        appendText(global.document, row, "pre", "zotero-math-patch-preview-value", operation.source);
        appendText(global.document, row, "div", "zotero-math-patch-preview-label", "LaTeX");
        appendText(global.document, row, "pre", "zotero-math-patch-preview-value", operation.latex);
        list.appendChild(row);
      });

      applyButton.addEventListener("command", () => this.accept());
      cancelButton.addEventListener("command", () => this.cancel());
      global.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          this.cancel();
        }
      });
      global.addEventListener("unload", () => {
        if (this.io && this.io.accepted !== true) {
          this.io.accepted = false;
        }
      }, { once: true });
    },

    accept() {
      if (this.io) {
        this.io.accepted = true;
      }
      global.close();
    },

    cancel() {
      if (this.io) {
        this.io.accepted = false;
      }
      global.close();
    },
  };

  function appendText(document, parent, tag, className, value) {
    const element = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    element.className = className;
    element.textContent = String(value || "");
    parent.appendChild(element);
  }

  global.ZoteroMathPatchPreview = ZoteroMathPatchPreview;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ZoteroMathPatchPreview;
  }
})(typeof window !== "undefined" ? window : globalThis);
