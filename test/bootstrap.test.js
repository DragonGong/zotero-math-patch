const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

module.exports = function runBootstrapTests() {
  const source = fs.readFileSync(path.join(__dirname, "..", "bootstrap.js"), "utf8");

  assert.doesNotMatch(
    source,
    /resource:\/\/gre\/modules\/(?:IOUtils|PathUtils)\.sys\.mjs/,
    "IOUtils and PathUtils are privileged window globals, not importable Zotero modules",
  );
  assert.match(source, /IOUtils:\s*domWindow\.IOUtils/);
  assert.match(source, /PathUtils:\s*domWindow\.PathUtils/);
  assert.ok(
    source.indexOf('chrome/content/logger.js') < source.indexOf('chrome/content/math-renderer.js'),
    "the logger is loaded before the runtime that consumes it",
  );
  assert.ok(
    source.indexOf('chrome/content/ai-workflow.js') < source.indexOf('chrome/content/ai-progress.js')
      && source.indexOf('chrome/content/ai-progress.js') < source.indexOf('chrome/content/math-renderer.js'),
    "the AI progress adapter is loaded before the runtime that consumes it",
  );

  console.log("bootstrap tests passed");
};
