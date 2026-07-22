(function (global) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const LOG_FILE_PATTERN = /^math-patch-.*\.jsonl$/;
  const HISTORY_PREF = "extensions.zotero.mathPatch.logDirectoryHistory";
  const REDACTED = "[REDACTED]";

  function createLogManager(options = {}) {
    const io = options.io || global.IOUtils;
    const pathUtils = options.pathUtils || global.PathUtils;
    const profileDir = String(options.profileDir || pathUtils?.profileDir || "");
    const getSettings = options.getSettings || (() => ({ loggingEnabled: true, logDirectory: "" }));
    const historyStore = options.historyStore || createEmptyHistoryStore();
    const metadataProvider = options.metadataProvider || (() => ({}));
    const now = options.now || (() => Date.now());
    const randomID = options.randomID || defaultRandomID;
    const reportError = options.reportError || (() => {});
    const defaultDirectory = pathUtils?.join?.(profileDir, "zotero-math-patch", "logs");
    const activeFiles = new Set();
    let maintenanceQueue = Promise.resolve();

    if (!io?.makeDirectory || !io?.writeUTF8 || !io?.getChildren || !io?.stat || !io?.remove) {
      throw new Error("Math Patch logging requires IOUtils-compatible file operations.");
    }
    if (!defaultDirectory) {
      throw new Error("Math Patch logging could not determine the Zotero profile directory.");
    }

    return {
      defaultDirectory,

      async startRun(feature, initialData = {}, initialSecrets = []) {
        await pruneExpiredLogs();
        const settings = safeGetSettings(getSettings);
        if (settings.loggingEnabled === false) {
          return createNoopTrace();
        }

        let directoryInfo;
        try {
          directoryInfo = await resolveDirectory(settings.logDirectory);
        }
        catch (error) {
          const warning = "Diagnostic logging is unavailable because no writable log directory could be opened.";
          safelyReport(reportError, error);
          return createNoopTrace(warning);
        }

        const startedAt = now();
        const timestamp = fileTimestamp(startedAt);
        const safeFeature = normalizeFeature(feature);
        const runID = `${timestamp}-${safeFeature}-${String(randomID()).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || defaultRandomID()}`;
        const filePath = pathUtils.join(directoryInfo.path, `math-patch-${runID}.jsonl`);
        const trace = createTrace({
          io,
          filePath,
          runID,
          feature: safeFeature,
          now,
          reportError,
          activeFiles,
          initialWarning: directoryInfo.warning,
        });
        for (const secret of Array.isArray(initialSecrets) ? initialSecrets : [initialSecrets]) {
          trace.addSecret(secret);
        }

        await trace.event("run_started", {
          ...safeMetadata(metadataProvider),
          ...initialData,
          logDirectory: directoryInfo.path,
          configuredLogDirectory: directoryInfo.configuredPath,
          usedDefaultDirectory: directoryInfo.isDefault,
        });
        if (directoryInfo.warning) {
          await trace.event("log_directory_fallback", {
            warning: directoryInfo.warning,
            fallbackDirectory: directoryInfo.path,
          });
        }
        return trace;
      },

      async getDirectoryInfo() {
        return resolveDirectory(safeGetSettings(getSettings).logDirectory);
      },

      async directoryChanged(previousDirectory, nextDirectory) {
        await rememberDirectories([previousDirectory, nextDirectory]);
        await pruneExpiredLogs();
        return resolveDirectory(nextDirectory);
      },

      async pruneExpiredLogs() {
        return pruneExpiredLogs();
      },
    };

    async function resolveDirectory(configuredDirectory) {
      const configuredPath = String(configuredDirectory || "").trim();
      const candidates = configuredPath && configuredPath !== defaultDirectory
        ? [configuredPath, defaultDirectory]
        : [defaultDirectory];
      let customError = null;

      for (const candidate of candidates) {
        try {
          await io.makeDirectory(candidate, { createAncestors: true, ignoreExisting: true });
          await verifyDirectoryWritable(candidate);
          await rememberDirectories([candidate, configuredPath]);
          return {
            path: candidate,
            configuredPath,
            isDefault: candidate === defaultDirectory,
            warning: customError
              ? `The configured log directory could not be used. Logs were written to ${defaultDirectory}.`
              : "",
          };
        }
        catch (error) {
          customError = error;
          safelyReport(reportError, error);
        }
      }
      throw customError || new Error("No writable log directory is available.");
    }

    async function verifyDirectoryWritable(directory) {
      const probeName = `math-patch-write-test-${fileTimestamp(now())}-${defaultRandomID()}.tmp`;
      const probePath = pathUtils.join(directory, probeName);
      try {
        await io.writeUTF8(probePath, "", { mode: "create" });
        await io.remove(probePath);
      }
      catch (error) {
        try {
          await io.remove(probePath);
        }
        catch (_cleanupError) {}
        throw error;
      }
    }

    async function pruneExpiredLogs() {
      const operation = maintenanceQueue.then(async () => {
        const cutoff = now() - RETENTION_MS;
        const directories = await getKnownDirectories();
        const candidates = [];

        for (const directory of directories) {
          let children;
          try {
            children = await io.getChildren(directory);
          }
          catch (_error) {
            continue;
          }
          for (const child of children) {
            const filename = getFilename(child);
            if (!LOG_FILE_PATTERN.test(filename) || activeFiles.has(child)) {
              continue;
            }
            try {
              const stats = await io.stat(child);
              const modified = Number(stats?.lastModified || 0);
              if (modified < cutoff) {
                candidates.push({ path: child, modified });
              }
            }
            catch (error) {
              safelyReport(reportError, error);
            }
          }
        }

        candidates.sort((left, right) => left.modified - right.modified);
        let removed = 0;
        for (const candidate of candidates) {
          if (activeFiles.has(candidate.path)) {
            continue;
          }
          try {
            await io.remove(candidate.path);
            removed++;
          }
          catch (error) {
            safelyReport(reportError, error);
          }
        }
        return { removed, cutoff };
      });

      maintenanceQueue = operation.catch((error) => {
        safelyReport(reportError, error);
        return { removed: 0, cutoff: now() - RETENTION_MS };
      });
      return maintenanceQueue;
    }

    async function getKnownDirectories() {
      const settings = safeGetSettings(getSettings);
      let history = [];
      try {
        history = normalizeHistory(await historyStore.get(HISTORY_PREF));
      }
      catch (error) {
        safelyReport(reportError, error);
      }
      return uniquePaths([
        defaultDirectory,
        settings.logDirectory,
        ...history,
      ]);
    }

    async function rememberDirectories(directories) {
      let history = [];
      try {
        history = normalizeHistory(await historyStore.get(HISTORY_PREF));
      }
      catch (error) {
        safelyReport(reportError, error);
      }
      const next = uniquePaths([...history, ...directories]);
      try {
        await historyStore.set(HISTORY_PREF, JSON.stringify(next));
      }
      catch (error) {
        safelyReport(reportError, error);
      }
    }
  }

  function createTrace(options) {
    const secrets = new Set();
    let sequence = 0;
    let writeQueue = Promise.resolve();
    let closed = false;
    let failed = false;
    let warning = options.initialWarning || "";
    options.activeFiles.add(options.filePath);

    return {
      enabled: true,
      filePath: options.filePath,
      runID: options.runID,
      feature: options.feature,

      addSecret(secret) {
        const value = String(secret || "");
        if (value) {
          secrets.add(value);
        }
      },

      async event(eventName, data = {}) {
        if (closed || failed) {
          return false;
        }
        const record = {
          schemaVersion: SCHEMA_VERSION,
          timestamp: new Date(options.now()).toISOString(),
          runId: options.runID,
          sequence: ++sequence,
          feature: options.feature,
          event: String(eventName || "event"),
          data,
        };

        writeQueue = writeQueue.then(async () => {
          const sanitized = redactForLog(record, Array.from(secrets));
          await options.io.writeUTF8(
            options.filePath,
            JSON.stringify(sanitized) + "\n",
            { mode: "appendOrCreate" },
          );
        }).catch((error) => {
          failed = true;
          warning = "Diagnostic logging stopped because the log file could not be written.";
          safelyReport(options.reportError, error);
        });
        await writeQueue;
        return !failed;
      },

      async finish(status, data = {}) {
        if (closed) {
          return !failed;
        }
        await this.event("run_finished", { status: String(status || "unknown"), ...data });
        closed = true;
        options.activeFiles.delete(options.filePath);
        return !failed;
      },

      getWarning() {
        return warning;
      },
    };
  }

  function createNoopTrace(warning = "") {
    return {
      enabled: false,
      filePath: null,
      runID: null,
      feature: null,
      addSecret() {},
      async event() { return false; },
      async finish() { return false; },
      getWarning() { return warning; },
    };
  }

  function redactForLog(value, secrets = []) {
    return sanitizeValue(value, secrets.filter(Boolean).map(String), new WeakSet(), "");
  }

  function sanitizeValue(value, secrets, seen, key) {
    if (isSensitiveKey(key)) {
      return REDACTED;
    }
    if (typeof value === "string") {
      return redactString(value, secrets);
    }
    if (value === null || ["number", "boolean"].includes(typeof value)) {
      return value;
    }
    if (typeof value === "bigint") {
      return String(value);
    }
    if (["undefined", "function", "symbol"].includes(typeof value)) {
      return null;
    }
    if (isErrorLike(value)) {
      return {
        name: redactString(String(value.name || "Error"), secrets),
        code: redactString(String(value.code || ""), secrets),
        message: redactString(String(value.message || ""), secrets),
        stack: redactString(String(value.stack || ""), secrets),
        status: Number.isFinite(Number(value.status)) ? Number(value.status) : null,
      };
    }
    if (typeof value === "object") {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
      if (Array.isArray(value)) {
        const result = value.map((item) => sanitizeValue(item, secrets, seen, ""));
        seen.delete(value);
        return result;
      }
      const result = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        result[childKey] = sanitizeValue(childValue, secrets, seen, childKey);
      }
      seen.delete(value);
      return result;
    }
    return redactString(String(value), secrets);
  }

  function redactString(value, secrets) {
    let redacted = String(value || "");
    for (const secret of secrets.sort((left, right) => right.length - left.length)) {
      if (secret) {
        redacted = redacted.split(secret).join(REDACTED);
      }
    }
    return redacted.replace(/\bBearer\s+[^\s"',}\]]+/gi, "Bearer " + REDACTED);
  }

  function isSensitiveKey(key) {
    return /^(?:api[_-]?key|x[_-]?api[_-]?key|authorization|proxy[_-]?authorization|auth|authentication|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|credential|credentials|secret|token)$/i.test(String(key || ""));
  }

  function isErrorLike(value) {
    if (value instanceof Error) {
      return true;
    }
    return !!value
      && typeof value === "object"
      && typeof value.name === "string"
      && typeof value.message === "string"
      && ("stack" in value || /error$/i.test(value.name));
  }

  function normalizeHistory(value) {
    if (Array.isArray(value)) {
      return uniquePaths(value);
    }
    try {
      const parsed = JSON.parse(String(value || "[]"));
      return Array.isArray(parsed) ? uniquePaths(parsed) : [];
    }
    catch (_error) {
      return [];
    }
  }

  function uniquePaths(paths) {
    return Array.from(new Set((paths || []).map((path) => String(path || "").trim()).filter(Boolean)));
  }

  function normalizeFeature(feature) {
    return String(feature || "operation")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "operation";
  }

  function fileTimestamp(milliseconds) {
    return new Date(milliseconds).toISOString().replace(/[:.]/g, "-");
  }

  function getFilename(path) {
    return String(path || "").split(/[\\/]/).pop() || "";
  }

  function safeGetSettings(provider) {
    try {
      return provider() || {};
    }
    catch (_error) {
      return {};
    }
  }

  function safeMetadata(provider) {
    try {
      const metadata = provider() || {};
      return typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
    }
    catch (_error) {
      return {};
    }
  }

  function safelyReport(reporter, error) {
    try {
      reporter(error);
    }
    catch (_error) {}
  }

  function createEmptyHistoryStore() {
    return {
      get() { return "[]"; },
      set() {},
    };
  }

  function defaultRandomID() {
    return Math.random().toString(36).slice(2, 12);
  }

  const api = {
    SCHEMA_VERSION,
    RETENTION_MS,
    LOG_FILE_PATTERN,
    HISTORY_PREF,
    createLogManager,
    createNoopTrace,
    redactForLog,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  else {
    global.ZoteroMathPatchLogger = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
