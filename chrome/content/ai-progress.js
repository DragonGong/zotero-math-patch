(function (global) {
  "use strict";

  const HEADLINE = "Processing Math with AI";
  const FRAME_DELAY_MS = 140;
  const FRAME_VALUES = Array.from({ length: 19 }, (_value, index) => (index + 1) * 5);

  function createProgressIndicator(options = {}) {
    const ZoteroImpl = options.Zotero || global.Zotero;
    const setTimer = options.setTimeoutImpl || global.setTimeout;
    const clearTimer = options.clearTimeoutImpl || global.clearTimeout;
    const onError = typeof options.onError === "function" ? options.onError : () => {};
    let progressWindow = null;
    let itemProgress = null;
    let timerID = null;
    let frameIndex = 0;
    let closed = false;
    let failed = false;

    const controller = {
      update(event) {
        if (closed || failed || !itemProgress) {
          return;
        }
        try {
          const text = formatProgressText(event);
          if (text) {
            itemProgress.setText(text);
          }
          if (event?.phase === "complete") {
            stopAnimation();
          }
        }
        catch (error) {
          fail(error);
        }
      },

      close() {
        if (closed) {
          return;
        }
        closed = true;
        stopAnimation();
        try {
          progressWindow?.close?.();
        }
        catch (error) {
          reportError(error);
        }
      },
    };

    try {
      if (typeof ZoteroImpl?.ProgressWindow !== "function") {
        throw new Error("Zotero ProgressWindow is unavailable.");
      }
      progressWindow = new ZoteroImpl.ProgressWindow({
        window: options.window || null,
        closeOnClick: false,
      });
      progressWindow.changeHeadline(HEADLINE);
      if (progressWindow.show() === false) {
        throw new Error("Zotero ProgressWindow could not be shown.");
      }
      itemProgress = new progressWindow.ItemProgress(
        null,
        formatProgressText({ phase: "preparing" }),
      );
      itemProgress.setProgress(FRAME_VALUES[frameIndex]);
      scheduleAnimation();
    }
    catch (error) {
      fail(error);
    }

    return controller;

    function scheduleAnimation() {
      if (closed || failed || typeof setTimer !== "function") {
        return;
      }
      try {
        timerID = setTimer(advanceAnimation, FRAME_DELAY_MS);
      }
      catch (error) {
        fail(error);
      }
    }

    function advanceAnimation() {
      timerID = null;
      if (closed || failed || !itemProgress) {
        return;
      }
      try {
        frameIndex = (frameIndex + 1) % FRAME_VALUES.length;
        itemProgress.setProgress(FRAME_VALUES[frameIndex]);
      }
      catch (error) {
        fail(error);
        return;
      }
      scheduleAnimation();
    }

    function stopAnimation() {
      if (timerID === null) {
        return;
      }
      try {
        clearTimer?.(timerID);
      }
      catch (error) {
        reportError(error);
      }
      timerID = null;
    }

    function fail(error) {
      if (failed || closed) {
        return;
      }
      failed = true;
      stopAnimation();
      reportError(error);
      try {
        progressWindow?.close?.();
      }
      catch (closeError) {
        reportError(closeError);
      }
      closed = true;
    }

    function reportError(error) {
      try {
        onError(error);
      }
      catch (_error) {}
    }
  }

  function formatProgressText(event = {}) {
    const current = positiveInteger(event.current);
    const total = positiveInteger(event.total);
    const batchSuffix = current && total ? `: batch ${current} of ${total}` : "";

    switch (event.phase) {
      case "preparing":
        return "Preparing note...";
      case "batches_ready":
        return total === 1 ? "Prepared 1 request batch." : `Prepared ${total || 0} request batches.`;
      case "requesting_batch":
        return `Waiting for model${batchSuffix}...`;
      case "validating_batch":
        return `Validating model result${batchSuffix}...`;
      case "repairing_operation": {
        const operationIndex = positiveInteger(event.operationIndex) || 1;
        const attempt = positiveInteger(event.attempt) || 1;
        const maxAttempts = positiveInteger(event.maxAttempts) || attempt;
        return `Repairing operation ${operationIndex}, attempt ${attempt} of ${maxAttempts}${batchSuffix}...`;
      }
      case "batch_completed":
        return current && total
          ? `Completed ${current} of ${total} request batches.`
          : "Completed model request.";
      case "validating_result":
        return "Validating and preparing formula changes...";
      case "preview_ready":
        return "Opening formula preview...";
      case "checking_note":
        return "Checking for concurrent note changes...";
      case "saving":
        return "Saving processed note...";
      case "complete":
        return completeText(event.status);
      default:
        return "";
    }
  }

  function completeText(status) {
    if (status === "saved") {
      return "Processing complete.";
    }
    if (status === "cancelled") {
      return "Processing cancelled.";
    }
    if (status === "no_text") {
      return "No processable note text was found.";
    }
    if (status === "no_formulas") {
      return "No damaged formulas were found.";
    }
    return "Processing stopped.";
  }

  function positiveInteger(value) {
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  const api = {
    createProgressIndicator,
    formatProgressText,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  else {
    global.ZoteroMathPatchAIProgress = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
