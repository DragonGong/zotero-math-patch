(function (global) {
  "use strict";

  const MAX_OPERATION_REPAIR_ATTEMPTS = 2;

  async function processNoteWithAI(options) {
    const core = options?.core || global.ZoteroMathPatchAICore;
    const originalHTML = String(options?.originalHTML || "");
    const settings = options?.settings || {};
    const provider = options?.provider;
    const trace = options?.trace;
    if (!core || !provider?.processBlocks || typeof options?.save !== "function") {
      throw new Error("The AI processing workflow is missing a required dependency.");
    }

    await safeTrace(trace, "workflow_input", {
      originalHTML,
      settings: {
        processingScope: settings.processingScope,
        showPreview: settings.showPreview,
        maxRequestChars: settings.maxRequestChars,
        maxOutputTokens: settings.maxOutputTokens,
        systemPrompt: settings.systemPrompt,
      },
    });

    try {
      const context = core.prepareNoteHTML(originalHTML);
      await safeTrace(trace, "safe_text_blocks", {
        blocks: context.blocks,
        blockCount: context.blocks.length,
      });
      if (!context.blocks.length) {
        await safeTrace(trace, "workflow_no_text", {});
        return emptyResult("no_text");
      }

      const batches = core.createBatches(
        context.blocks,
        settings.maxRequestChars,
        options.contextSize === undefined ? 1 : options.contextSize,
      );
      await safeTrace(trace, "batches_created", {
        batchCount: batches.length,
        batches: batches.map((batch) => ({
          id: batch.id,
          blocks: batch.blocks,
          allowedBlockIds: batch.allowedBlockIds,
        })),
      });
      const batchResults = [];

      for (let index = 0; index < batches.length; index++) {
        const batch = batches[index];
        const progress = {
          current: index + 1,
          total: batches.length,
          batchId: batch.id,
        };
        options.onBatch?.(progress);
        await safeTrace(trace, "batch_started", {
          ...progress,
          blocks: batch.blocks,
          allowedBlockIds: batch.allowedBlockIds,
        });
        let payload;
        try {
          payload = await provider.processBlocks({
            blocks: batch.blocks,
            prompt: settings.systemPrompt,
            signal: options.signal,
            trace,
          });
        }
        catch (error) {
          await safeTrace(trace, "batch_failed", { ...progress, error });
          throw error;
        }
        await safeTrace(trace, "batch_candidate_received", {
          ...progress,
          payload,
        });
        payload = await validateAndRepairBatch({
          payload,
          batch,
          progress,
          context,
          core,
          provider,
          prompt: settings.systemPrompt,
          signal: options.signal,
          trace,
          maxRepairAttempts: Number.isInteger(options.maxRepairAttempts)
            ? Math.max(0, options.maxRepairAttempts)
            : MAX_OPERATION_REPAIR_ATTEMPTS,
        });
        await safeTrace(trace, "batch_completed", {
          ...progress,
          payload,
        });
        batchResults.push({
          payload,
          allowedBlockIds: batch.allowedBlockIds,
        });
      }

      let merged;
      try {
        merged = core.mergeBatchResults(batchResults, context);
      }
      catch (error) {
        await safeTrace(trace, "model_validation_failed", {
          batchResults,
          error,
        });
        throw error;
      }
      await safeTrace(trace, "operations_merged_and_validated", {
        operations: merged.operations,
        operationCount: merged.operations.length,
      });
      if (!merged.operations.length) {
        await safeTrace(trace, "workflow_no_formulas", { batchCount: batches.length });
        return emptyResult("no_formulas", batches.length);
      }

      let applied;
      try {
        applied = core.applyModelOperations(originalHTML, {
          operations: merged.operations,
        });
      }
      catch (error) {
        await safeTrace(trace, "operation_application_failed", {
          operations: merged.operations,
          error,
        });
        throw error;
      }
      await safeTrace(trace, "output_prepared", {
        changed: applied.changed,
        finalHTML: applied.html,
        operations: applied.operations,
        stats: applied.stats,
      });
      if (!applied.changed) {
        await safeTrace(trace, "workflow_no_formulas", { batchCount: batches.length });
        return emptyResult("no_formulas", batches.length);
      }

      if (settings.showPreview && typeof options.confirmPreview === "function") {
        await safeTrace(trace, "preview_opened", {
          operations: applied.operations,
          stats: applied.stats,
        });
        const accepted = await options.confirmPreview({
          operations: applied.operations,
          stats: applied.stats,
        });
        await safeTrace(trace, "preview_decision", { accepted: accepted === true });
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
        await safeTrace(trace, "concurrent_edit_check", {
          changed: currentHTML !== originalHTML,
          currentHTML,
        });
        if (currentHTML !== originalHTML) {
          throw new core.AIValidationError(
            "note_changed",
            "The note changed while the model request was running. Nothing was saved; run the command again.",
          );
        }
      }

      await safeTrace(trace, "save_started", { finalHTML: applied.html });
      try {
        await options.save(applied.html);
      }
      catch (error) {
        await safeTrace(trace, "save_failed", { error, originalHTML, attemptedHTML: applied.html });
        throw error;
      }
      await safeTrace(trace, "save_completed", { finalHTML: applied.html });
      return {
        status: "saved",
        saved: true,
        html: applied.html,
        stats: applied.stats,
        operations: applied.operations,
        batchCount: batches.length,
      };
    }
    catch (error) {
      await safeTrace(trace, "workflow_error", {
        error,
        originalHTML,
      });
      throw error;
    }
  }

  async function validateAndRepairBatch(options) {
    let payload = options.payload;
    let repairAttempts = 0;
    let previousRepairFeedback = null;

    while (true) {
      try {
        options.core.validateModelResponse(payload, options.context, {
          allowedBlockIds: options.batch.allowedBlockIds,
        });
        if (repairAttempts) {
          await safeTrace(options.trace, "operation_repair_validated", {
            ...options.progress,
            repairAttempts,
            payload,
          });
        }
        return payload;
      }
      catch (error) {
        await safeTrace(options.trace, "batch_validation_failed", {
          ...options.progress,
          repairAttempts,
          payload,
          error,
        });

        const operationIndex = Number.isInteger(error?.operationIndex)
          ? error.operationIndex
          : null;
        if (
          operationIndex === null
          || repairAttempts >= options.maxRepairAttempts
          || typeof options.provider.repairOperation !== "function"
        ) {
          await safeTrace(options.trace, "model_validation_failed", {
            batchResults: [{
              payload,
              allowedBlockIds: options.batch.allowedBlockIds,
            }],
            error,
          });
          throw error;
        }

        repairAttempts++;
        await safeTrace(options.trace, "operation_repair_started", {
          ...options.progress,
          repairAttempt: repairAttempts,
          operationIndex: operationIndex + 1,
          error,
        });

        let repair;
        try {
          repair = await options.provider.repairOperation({
            blocks: options.batch.blocks,
            prompt: options.prompt,
            candidate: payload,
            operationIndex: operationIndex + 1,
            validationError: error,
            previousRepairFeedback,
            signal: options.signal,
            trace: options.trace,
          });
        }
        catch (repairRequestError) {
          await safeTrace(options.trace, "operation_repair_request_failed", {
            ...options.progress,
            repairAttempt: repairAttempts,
            operationIndex: operationIndex + 1,
            error: repairRequestError,
          });
          throw repairRequestError;
        }

        await safeTrace(options.trace, "operation_repair_received", {
          ...options.progress,
          repairAttempt: repairAttempts,
          operationIndex: operationIndex + 1,
          repair,
        });
        try {
          payload = options.core.applyOperationRepair(payload, repair, options.context, {
            allowedBlockIds: options.batch.allowedBlockIds,
            operationIndex,
          });
          previousRepairFeedback = null;
        }
        catch (repairError) {
          previousRepairFeedback = { repair, error: repairError };
          await safeTrace(options.trace, "operation_repair_rejected", {
            ...options.progress,
            repairAttempt: repairAttempts,
            operationIndex: operationIndex + 1,
            repair,
            error: repairError,
          });
          if (repairAttempts >= options.maxRepairAttempts) {
            await safeTrace(options.trace, "model_validation_failed", {
              batchResults: [{
                payload,
                allowedBlockIds: options.batch.allowedBlockIds,
              }],
              repair,
              error: repairError,
            });
            throw repairError;
          }
        }
      }
    }
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

  async function safeTrace(trace, eventName, data) {
    try {
      await trace?.event?.(eventName, data);
    }
    catch (_error) {}
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
