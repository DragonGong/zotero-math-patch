(function (global) {
  "use strict";

  const MAX_OPERATION_REPAIR_ATTEMPTS = 2;
  const MAX_BATCH_REPAIR_ATTEMPTS = 8;

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
    await safeProgress(options.onProgress, { phase: "preparing" });

    try {
      const context = core.prepareNoteHTML(originalHTML);
      await safeTrace(trace, "safe_text_blocks", {
        blocks: context.blocks,
        blockCount: context.blocks.length,
      });
      if (!context.blocks.length) {
        await safeTrace(trace, "workflow_no_text", {});
        await safeProgress(options.onProgress, { phase: "complete", status: "no_text" });
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
      await safeProgress(options.onProgress, {
        phase: "batches_ready",
        total: batches.length,
      });
      const batchResults = [];
      let ignoredProtectedOperations = 0;
      let ignoredRedundantOperations = 0;

      for (let index = 0; index < batches.length; index++) {
        const batch = batches[index];
        const progress = {
          current: index + 1,
          total: batches.length,
          batchId: batch.id,
        };
        options.onBatch?.(progress);
        await safeProgress(options.onProgress, {
          phase: "requesting_batch",
          ...progress,
        });
        await safeTrace(trace, "batch_started", {
          ...progress,
          blocks: batch.blocks,
          allowedBlockIds: batch.allowedBlockIds,
        });
        let payload;
        try {
          payload = await provider.processBlocks({
            blocks: batch.blocks,
            editableBlockIds: batch.allowedBlockIds,
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
        if (typeof core.filterUneditableInlineOperations === "function") {
          const filtered = core.filterUneditableInlineOperations(payload, context);
          if (filtered.removed.length) {
            ignoredProtectedOperations += filtered.removed.length;
            await safeTrace(trace, "protected_operations_ignored", {
              ...progress,
              removed: filtered.removed,
            });
          }
          payload = filtered.payload;
        }
        if (typeof core.filterRedundantOperations === "function") {
          const filtered = core.filterRedundantOperations(payload, context, {
            allowedBlockIds: batch.allowedBlockIds,
          });
          if (filtered.removed.length) {
            ignoredRedundantOperations += filtered.removed.length;
            await safeTrace(trace, "redundant_operations_ignored", {
              ...progress,
              removed: filtered.removed,
            });
          }
          payload = filtered.payload;
        }
        await safeProgress(options.onProgress, {
          phase: "validating_batch",
          ...progress,
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
          onProgress: options.onProgress,
          maxRepairAttemptsPerOperation: Number.isInteger(options.maxRepairAttempts)
            ? Math.max(0, options.maxRepairAttempts)
            : MAX_OPERATION_REPAIR_ATTEMPTS,
          maxTotalRepairAttempts: Number.isInteger(options.maxTotalRepairAttempts)
            ? Math.max(0, options.maxTotalRepairAttempts)
            : MAX_BATCH_REPAIR_ATTEMPTS,
        });
        await safeTrace(trace, "batch_completed", {
          ...progress,
          payload,
        });
        await safeProgress(options.onProgress, {
          phase: "batch_completed",
          ...progress,
        });
        batchResults.push({
          payload,
          allowedBlockIds: batch.allowedBlockIds,
        });
      }

      await safeProgress(options.onProgress, {
        phase: "validating_result",
        total: batches.length,
      });
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
        await safeTrace(trace, "workflow_no_formulas", {
          batchCount: batches.length,
          ignoredProtectedOperations,
          ignoredRedundantOperations,
        });
        await safeProgress(options.onProgress, { phase: "complete", status: "no_formulas" });
        return emptyResult(
          "no_formulas",
          batches.length,
          ignoredProtectedOperations,
          ignoredRedundantOperations,
        );
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
        await safeTrace(trace, "workflow_no_formulas", {
          batchCount: batches.length,
          ignoredProtectedOperations,
          ignoredRedundantOperations,
        });
        await safeProgress(options.onProgress, { phase: "complete", status: "no_formulas" });
        return emptyResult(
          "no_formulas",
          batches.length,
          ignoredProtectedOperations,
          ignoredRedundantOperations,
        );
      }

      if (settings.showPreview && typeof options.confirmPreview === "function") {
        await safeProgress(options.onProgress, {
          phase: "preview_ready",
          stats: applied.stats,
        });
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
          await safeProgress(options.onProgress, { phase: "complete", status: "cancelled" });
          return {
            status: "cancelled",
            saved: false,
            stats: applied.stats,
            operations: applied.operations,
            batchCount: batches.length,
            ignoredProtectedOperations,
            ignoredRedundantOperations,
          };
        }
      }

      if (typeof options.getCurrentHTML === "function") {
        await safeProgress(options.onProgress, { phase: "checking_note" });
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

      await safeProgress(options.onProgress, { phase: "saving" });
      await safeTrace(trace, "save_started", { finalHTML: applied.html });
      try {
        await options.save(applied.html);
      }
      catch (error) {
        await safeTrace(trace, "save_failed", { error, originalHTML, attemptedHTML: applied.html });
        throw error;
      }
      await safeTrace(trace, "save_completed", { finalHTML: applied.html });
      await safeProgress(options.onProgress, { phase: "complete", status: "saved" });
      return {
        status: "saved",
        saved: true,
        html: applied.html,
        stats: applied.stats,
        operations: applied.operations,
        batchCount: batches.length,
        ignoredProtectedOperations,
        ignoredRedundantOperations,
      };
    }
    catch (error) {
      await safeProgress(options.onProgress, {
        phase: "complete",
        status: "error",
        errorCode: String(error?.code || error?.name || "unknown_error"),
      });
      await safeTrace(trace, "workflow_error", {
        error,
        originalHTML,
      });
      throw error;
    }
  }

  async function validateAndRepairBatch(options) {
    let payload = options.payload;
    let totalRepairAttempts = 0;
    const attemptsByOperation = new Map();
    const feedbackByOperation = new Map();
    const operationKeys = Array.from(
      { length: Array.isArray(payload?.operations) ? payload.operations.length : 0 },
      () => Symbol("operation"),
    );

    while (true) {
      try {
        options.core.validateModelResponse(payload, options.context, {
          allowedBlockIds: options.batch.allowedBlockIds,
        });
        if (totalRepairAttempts) {
          await safeTrace(options.trace, "operation_repair_validated", {
            ...options.progress,
            repairAttempts: totalRepairAttempts,
            payload,
          });
        }
        return payload;
      }
      catch (error) {
        await safeTrace(options.trace, "batch_validation_failed", {
          ...options.progress,
          repairAttempts: totalRepairAttempts,
          payload,
          error,
        });

        const operationIndex = Number.isInteger(error?.operationIndex)
          ? error.operationIndex
          : null;
        const invalidOperation = operationIndex === null
          ? null
          : payload?.operations?.[operationIndex];
        const operationKey = operationIndex === null
          ? null
          : operationKeys[operationIndex] || null;
        const operationAttempts = attemptsByOperation.get(operationKey) || 0;
        if (
          operationIndex === null
          || operationAttempts >= options.maxRepairAttemptsPerOperation
          || totalRepairAttempts >= options.maxTotalRepairAttempts
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

        const operationAttempt = operationAttempts + 1;
        totalRepairAttempts++;
        attemptsByOperation.set(operationKey, operationAttempt);
        await safeProgress(options.onProgress, {
          phase: "repairing_operation",
          ...options.progress,
          operationIndex: operationIndex + 1,
          attempt: operationAttempt,
          maxAttempts: options.maxRepairAttemptsPerOperation,
          totalAttempt: totalRepairAttempts,
          maxTotalAttempts: options.maxTotalRepairAttempts,
        });
        await safeTrace(options.trace, "operation_repair_started", {
          ...options.progress,
          repairAttempt: operationAttempt,
          totalRepairAttempt: totalRepairAttempts,
          operationIndex: operationIndex + 1,
          error,
        });

        let repair;
        try {
          repair = await options.provider.repairOperation({
            blocks: options.batch.blocks,
            editableBlockIds: options.batch.allowedBlockIds,
            prompt: options.prompt,
            candidate: payload,
            operationIndex: operationIndex + 1,
            validationError: error,
            previousRepairFeedback: feedbackByOperation.get(operationKey) || null,
            signal: options.signal,
            trace: options.trace,
          });
        }
        catch (repairRequestError) {
          await safeTrace(options.trace, "operation_repair_request_failed", {
            ...options.progress,
            repairAttempt: operationAttempt,
            totalRepairAttempt: totalRepairAttempts,
            operationIndex: operationIndex + 1,
            error: repairRequestError,
          });
          throw repairRequestError;
        }

        await safeTrace(options.trace, "operation_repair_received", {
          ...options.progress,
          repairAttempt: operationAttempt,
          totalRepairAttempt: totalRepairAttempts,
          operationIndex: operationIndex + 1,
          repair,
        });
        try {
          const repairedPayload = options.core.applyOperationRepair(payload, repair, options.context, {
            allowedBlockIds: options.batch.allowedBlockIds,
            operationIndex,
          });
          if (repair?.action === "remove") {
            operationKeys.splice(operationIndex, 1);
          }
          payload = repairedPayload;
          feedbackByOperation.delete(operationKey);
        }
        catch (repairError) {
          feedbackByOperation.set(operationKey, { repair, error: repairError });
          await safeTrace(options.trace, "operation_repair_rejected", {
            ...options.progress,
            repairAttempt: operationAttempt,
            totalRepairAttempt: totalRepairAttempts,
            operationIndex: operationIndex + 1,
            repair,
            error: repairError,
          });
          if (
            operationAttempt >= options.maxRepairAttemptsPerOperation
            || totalRepairAttempts >= options.maxTotalRepairAttempts
          ) {
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

  function emptyResult(
    status,
    batchCount = 0,
    ignoredProtectedOperations = 0,
    ignoredRedundantOperations = 0,
  ) {
    return {
      status,
      saved: false,
      stats: { inline: 0, block: 0 },
      operations: [],
      batchCount,
      ignoredProtectedOperations,
      ignoredRedundantOperations,
    };
  }

  async function safeTrace(trace, eventName, data) {
    try {
      await trace?.event?.(eventName, data);
    }
    catch (_error) {}
  }

  function safeProgress(callback, event) {
    try {
      const result = callback?.(event);
      result?.catch?.(() => {});
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
