(function (global) {
  "use strict";

  async function processNoteWithAI(options) {
    const core = options?.core || global.ZoteroMathPatchAICore;
    const originalHTML = String(options?.originalHTML || "");
    const settings = options?.settings || {};
    const provider = options?.provider;
    if (!core || !provider?.processBlocks || typeof options?.save !== "function") {
      throw new Error("The AI processing workflow is missing a required dependency.");
    }

    const context = core.prepareNoteHTML(originalHTML);
    if (!context.blocks.length) {
      return emptyResult("no_text");
    }

    const batches = core.createBatches(
      context.blocks,
      settings.maxRequestChars,
      options.contextSize === undefined ? 1 : options.contextSize,
    );
    const batchResults = [];

    for (let index = 0; index < batches.length; index++) {
      const batch = batches[index];
      options.onBatch?.({
        current: index + 1,
        total: batches.length,
        batchId: batch.id,
      });
      const payload = await provider.processBlocks({
        blocks: batch.blocks,
        prompt: settings.systemPrompt,
        signal: options.signal,
      });
      batchResults.push({
        payload,
        allowedBlockIds: batch.allowedBlockIds,
      });
    }

    const merged = core.mergeBatchResults(batchResults, context);
    if (!merged.operations.length) {
      return emptyResult("no_formulas", batches.length);
    }

    const applied = core.applyModelOperations(originalHTML, {
      operations: merged.operations,
    });
    if (!applied.changed) {
      return emptyResult("no_formulas", batches.length);
    }

    if (settings.showPreview && typeof options.confirmPreview === "function") {
      const accepted = await options.confirmPreview({
        operations: applied.operations,
        stats: applied.stats,
      });
      if (!accepted) {
        return {
          status: "cancelled",
          saved: false,
          stats: applied.stats,
          operations: applied.operations,
          batchCount: batches.length,
        };
      }
    }

    if (typeof options.getCurrentHTML === "function") {
      const currentHTML = String((await options.getCurrentHTML()) || "");
      if (currentHTML !== originalHTML) {
        throw new core.AIValidationError(
          "note_changed",
          "The note changed while the model request was running. Nothing was saved; run the command again.",
        );
      }
    }

    await options.save(applied.html);
    return {
      status: "saved",
      saved: true,
      html: applied.html,
      stats: applied.stats,
      operations: applied.operations,
      batchCount: batches.length,
    };
  }

  function emptyResult(status, batchCount = 0) {
    return {
      status,
      saved: false,
      stats: { inline: 0, block: 0 },
      operations: [],
      batchCount,
    };
  }

  const api = {
    processNoteWithAI,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  else {
    global.ZoteroMathPatchAIWorkflow = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
