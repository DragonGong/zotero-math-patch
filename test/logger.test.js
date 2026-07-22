const assert = require("node:assert/strict");
const {
  RETENTION_MS,
  createLogManager,
} = require("../chrome/content/logger.js");

module.exports = async function runLoggerTests() {
  await testJSONLAndRedaction();
  await testRetentionAndActiveFiles();
  await testDirectoryFallbackAndFailures();
  await testDisabledLoggingStillPrunes();
  console.log("logger tests passed");
};

async function testJSONLAndRedaction() {
  const io = new MemoryIO();
  const history = new MemoryHistory();
  let currentTime = Date.parse("2026-07-22T08:00:00.000Z");
  let random = 0;
  const manager = createLogManager({
    io,
    pathUtils: fakePathUtils(),
    profileDir: "/profile",
    getSettings: () => ({ loggingEnabled: true, logDirectory: "/project/logs" }),
    historyStore: history,
    metadataProvider: () => ({ pluginVersion: "0.3.0", zoteroVersion: "9.0.5" }),
    now: () => currentTime++,
    randomID: () => `run${++random}`,
  });

  const trace = await manager.startRun(
    "process_math_with_ai",
    { note: "中文笔记 containing startup-secret" },
    ["startup-secret"],
  );
  trace.addSecret("sk-private-key");
  await trace.event("provider_exchange", {
    request: {
      apiKey: "must-not-survive",
      authorization: "Bearer hidden-token",
      "X-API-Key": "nested-auth-value",
      prompt: "contains sk-private-key",
    },
    response: {
      latex: String.raw`\text{平均性能}`,
      echoed: "sk-private-key",
    },
    error: Object.assign(new Error("failed with sk-private-key"), { code: "sample_error" }),
    crossRealmError: {
      name: "NetworkError",
      message: "cross-realm sk-private-key",
      stack: "NetworkError: sk-private-key",
    },
  });
  await trace.finish("success", { saved: true });

  const files = io.filePaths("/project/logs");
  assert.equal(files.length, 1);
  assert.match(files[0], /math-patch-.*-process_math_with_ai-run1\.jsonl$/);
  const raw = io.read(files[0]);
  assert.equal(raw.includes("sk-private-key"), false);
  assert.equal(raw.includes("startup-secret"), false);
  assert.equal(raw.includes("hidden-token"), false);
  assert.equal(raw.includes("must-not-survive"), false);
  assert.equal(raw.includes("nested-auth-value"), false);
  assert.match(raw, /\[REDACTED\]/);
  assert.match(raw, /中文笔记/);
  assert.match(raw, /平均性能/);

  const records = parseJSONL(raw);
  assert.deepEqual(records.map((record) => record.sequence), [1, 2, 3]);
  assert.deepEqual(records.map((record) => record.event), [
    "run_started",
    "provider_exchange",
    "run_finished",
  ]);
  assert.equal(records[0].data.pluginVersion, "0.3.0");
  assert.equal(records[1].data.request.apiKey, "[REDACTED]");
  assert.equal(records[1].data.response.latex, String.raw`\text{平均性能}`);

  const second = await manager.startRun("process_math_with_ai");
  await second.finish("success");
  assert.equal(io.filePaths("/project/logs").length, 2, "each operation receives a unique file");
}

async function testRetentionAndActiveFiles() {
  const io = new MemoryIO();
  const now = Date.parse("2026-07-22T08:00:00.000Z");
  const cutoff = now - RETENTION_MS;
  io.addFile("/profile/zotero-math-patch/logs/math-patch-old.jsonl", "old", cutoff - 300);
  io.addFile("/profile/zotero-math-patch/logs/math-patch-boundary.jsonl", "boundary", cutoff);
  io.addFile("/profile/zotero-math-patch/logs/unrelated.txt", "keep", cutoff - 1000);
  io.addFile("/old-custom/math-patch-history.jsonl", "old custom", cutoff - 100);
  const history = new MemoryHistory(["/old-custom"]);
  let clock = now;
  io.now = () => clock;
  const manager = createLogManager({
    io,
    pathUtils: fakePathUtils(),
    profileDir: "/profile",
    getSettings: () => ({ loggingEnabled: true, logDirectory: "" }),
    historyStore: history,
    now: () => clock,
    randomID: () => "active",
  });

  const result = await manager.pruneExpiredLogs();
  assert.equal(result.removed, 2);
  assert.equal(io.has("/profile/zotero-math-patch/logs/math-patch-old.jsonl"), false);
  assert.equal(io.has("/old-custom/math-patch-history.jsonl"), false);
  assert.equal(io.has("/profile/zotero-math-patch/logs/math-patch-boundary.jsonl"), true);
  assert.equal(io.has("/profile/zotero-math-patch/logs/unrelated.txt"), true);
  assert.deepEqual(io.removedPaths.slice(0, 2), [
    "/profile/zotero-math-patch/logs/math-patch-old.jsonl",
    "/old-custom/math-patch-history.jsonl",
  ], "expired logs are deleted oldest-first across known directories");

  const active = await manager.startRun("rule");
  const activePath = active.filePath;
  clock += RETENTION_MS + 1;
  await manager.pruneExpiredLogs();
  assert.equal(io.has(activePath), true, "an active log is not removed during cleanup");
  await active.finish("success");
  assert.equal(io.has(activePath), true, "finishing the run refreshes the log modification time");
  clock += RETENTION_MS + 1;
  await manager.pruneExpiredLogs();
  assert.equal(io.has(activePath), false, "a finished expired log is removed oldest-first");
}

async function testDirectoryFallbackAndFailures() {
  const io = new MemoryIO();
  io.failWritesForDirectories.add("/unwritable");
  const errors = [];
  const manager = createLogManager({
    io,
    pathUtils: fakePathUtils(),
    profileDir: "/profile",
    getSettings: () => ({ loggingEnabled: true, logDirectory: "/unwritable" }),
    historyStore: new MemoryHistory(),
    reportError: (error) => errors.push(error),
    now: () => Date.parse("2026-07-22T08:00:00.000Z"),
    randomID: () => "fallback",
  });

  const trace = await manager.startRun("test_connection");
  assert.equal(trace.enabled, true);
  assert.equal(trace.filePath.startsWith("/profile/zotero-math-patch/logs/"), true);
  assert.match(trace.getWarning(), /configured log directory could not be used/i);
  await trace.finish("success");
  assert.ok(errors.length >= 1);

  const brokenIO = new MemoryIO();
  brokenIO.failAllDirectories = true;
  const unavailable = createLogManager({
    io: brokenIO,
    pathUtils: fakePathUtils(),
    profileDir: "/profile",
    getSettings: () => ({ loggingEnabled: true, logDirectory: "/unwritable" }),
  });
  const noLog = await unavailable.startRun("rule");
  assert.equal(noLog.enabled, false);
  assert.match(noLog.getWarning(), /logging is unavailable/i);

  const writeFailureIO = new MemoryIO();
  writeFailureIO.failWritesAfter = 1;
  const writeFailure = createLogManager({
    io: writeFailureIO,
    pathUtils: fakePathUtils(),
    profileDir: "/profile",
    getSettings: () => ({ loggingEnabled: true, logDirectory: "" }),
  });
  const failedTrace = await writeFailure.startRun("rule");
  assert.match(failedTrace.getWarning(), /logging stopped/i);
  await assert.doesNotReject(failedTrace.finish("error"));
}

async function testDisabledLoggingStillPrunes() {
  const io = new MemoryIO();
  const now = Date.parse("2026-07-22T08:00:00.000Z");
  io.addFile(
    "/profile/zotero-math-patch/logs/math-patch-disabled-old.jsonl",
    "old",
    now - RETENTION_MS - 1,
  );
  const manager = createLogManager({
    io,
    pathUtils: fakePathUtils(),
    profileDir: "/profile",
    getSettings: () => ({ loggingEnabled: false, logDirectory: "" }),
    now: () => now,
  });

  const trace = await manager.startRun("rule");
  assert.equal(trace.enabled, false);
  assert.equal(io.filePaths("/profile/zotero-math-patch/logs").length, 0);
}

class MemoryIO {
  constructor() {
    this.files = new Map();
    this.directories = new Set();
    this.failDirectories = new Set();
    this.failAllDirectories = false;
    this.failWrites = false;
    this.failWritesAfter = Infinity;
    this.failWritesForDirectories = new Set();
    this.writeCount = 0;
    this.removedPaths = [];
    this.now = () => Date.now();
  }

  async makeDirectory(path) {
    if (this.failAllDirectories || this.failDirectories.has(path)) {
      throw new Error("directory unavailable: " + path);
    }
    this.directories.add(path);
  }

  async writeUTF8(path, text, options) {
    this.writeCount++;
    if (this.failWrites || this.writeCount > this.failWritesAfter
      || this.failWritesForDirectories.has(dirname(path))) {
      throw new Error("write failed");
    }
    assert.equal(["appendOrCreate", "create"].includes(options.mode), true);
    if (options.mode === "create" && this.files.has(path)) {
      throw new Error("file exists");
    }
    const current = this.files.get(path) || { content: "", lastModified: this.now() };
    current.content += text;
    current.lastModified = this.now();
    this.files.set(path, current);
  }

  async getChildren(directory) {
    if (!this.directories.has(directory) && !this.filePaths(directory).length) {
      throw new Error("directory missing");
    }
    return this.filePaths(directory);
  }

  async stat(path) {
    const file = this.files.get(path);
    if (!file) {
      throw new Error("file missing");
    }
    return { type: "regular", lastModified: file.lastModified, size: file.content.length };
  }

  async remove(path) {
    if (!this.files.delete(path)) {
      throw new Error("file missing");
    }
    this.removedPaths.push(path);
  }

  addFile(path, content, lastModified) {
    this.directories.add(dirname(path));
    this.files.set(path, { content, lastModified });
  }

  filePaths(directory) {
    return Array.from(this.files.keys()).filter((path) => dirname(path) === directory).sort();
  }

  read(path) {
    return this.files.get(path)?.content || "";
  }

  has(path) {
    return this.files.has(path);
  }
}

class MemoryHistory {
  constructor(directories = []) {
    this.value = JSON.stringify(directories);
  }

  get() {
    return this.value;
  }

  set(_key, value) {
    this.value = value;
  }
}

function fakePathUtils() {
  return {
    profileDir: "/profile",
    join(...parts) {
      return parts.join("/").replace(/\/+/g, "/");
    },
  };
}

function dirname(path) {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

function parseJSONL(text) {
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
