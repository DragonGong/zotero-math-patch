const assert = require("node:assert/strict");
const {
  createProgressIndicator,
  formatProgressText,
} = require("../chrome/content/ai-progress.js");

module.exports = function runAIProgressTests() {
  testNativeProgressLifecycle();
  testProgressFailureIsolation();
  testProgressText();
  console.log("AI progress tests passed");
};

function testNativeProgressLifecycle() {
  const fixture = createProgressWindowFixture();
  const timers = createFakeTimers();
  const owner = { name: "note-window" };
  const errors = [];
  const indicator = createProgressIndicator({
    Zotero: fixture.Zotero,
    window: owner,
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
    onError: (error) => errors.push(error),
  });

  assert.equal(fixture.windows.length, 1);
  const progressWindow = fixture.windows[0];
  assert.deepEqual(progressWindow.options, { window: owner, closeOnClick: false });
  assert.equal(progressWindow.headline, "Processing Math with AI");
  assert.equal(progressWindow.showCount, 1);
  assert.equal(progressWindow.items.length, 1);
  const item = progressWindow.items[0];
  assert.equal(item.text, "Preparing note...");
  assert.deepEqual(item.progressValues, [5]);
  assert.equal(timers.pendingCount(), 1);

  timers.runNext();
  assert.deepEqual(item.progressValues, [5, 10]);
  assert.equal(timers.pendingCount(), 1, "the native circle keeps animating");

  indicator.update({ phase: "requesting_batch", current: 2, total: 5 });
  assert.equal(item.text, "Waiting for model: batch 2 of 5...");
  indicator.update({
    phase: "repairing_operation",
    operationIndex: 16,
    attempt: 1,
    maxAttempts: 2,
    current: 2,
    total: 5,
  });
  assert.equal(item.text, "Repairing operation 16, attempt 1 of 2: batch 2 of 5...");

  indicator.update({ phase: "complete", status: "saved" });
  assert.equal(item.text, "Processing complete.");
  assert.equal(timers.pendingCount(), 0, "completion stops the animation timer");
  indicator.close();
  indicator.close();
  assert.equal(progressWindow.closeCount, 1, "closing is idempotent");
  assert.deepEqual(errors, []);
}

function testProgressFailureIsolation() {
  const unavailableErrors = [];
  const unavailable = createProgressIndicator({
    Zotero: {},
    onError: (error) => unavailableErrors.push(error),
  });
  assert.doesNotThrow(() => unavailable.update({ phase: "saving" }));
  assert.doesNotThrow(() => unavailable.close());
  assert.equal(unavailableErrors.length, 1);

  const fixture = createProgressWindowFixture({ failOnText: "Saving processed note..." });
  const timers = createFakeTimers();
  const errors = [];
  const indicator = createProgressIndicator({
    Zotero: fixture.Zotero,
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
    onError: (error) => errors.push(error),
  });
  assert.doesNotThrow(() => indicator.update({ phase: "saving" }));
  assert.equal(errors.length, 1);
  assert.equal(fixture.windows[0].closeCount, 1);
  assert.equal(timers.pendingCount(), 0);
  assert.doesNotThrow(() => indicator.close());
  assert.equal(fixture.windows[0].closeCount, 1);

  assert.doesNotThrow(() => createProgressIndicator({
    Zotero: {},
    onError() {
      throw new Error("error reporter failed");
    },
  }), "an error reporter failure is also isolated");
}

function testProgressText() {
  assert.equal(formatProgressText({ phase: "batches_ready", total: 1 }), "Prepared 1 request batch.");
  assert.equal(formatProgressText({ phase: "batches_ready", total: 3 }), "Prepared 3 request batches.");
  assert.equal(
    formatProgressText({ phase: "validating_batch", current: 1, total: 3 }),
    "Validating model result: batch 1 of 3...",
  );
  assert.equal(
    formatProgressText({ phase: "batch_completed", current: 2, total: 3 }),
    "Completed 2 of 3 request batches.",
  );
  assert.equal(formatProgressText({ phase: "validating_result" }), "Validating and preparing formula changes...");
  assert.equal(formatProgressText({ phase: "preview_ready" }), "Opening formula preview...");
  assert.equal(formatProgressText({ phase: "checking_note" }), "Checking for concurrent note changes...");
  assert.equal(formatProgressText({ phase: "saving" }), "Saving processed note...");
  assert.equal(formatProgressText({ phase: "complete", status: "cancelled" }), "Processing cancelled.");
  assert.equal(formatProgressText({ phase: "unknown" }), "");
}

function createProgressWindowFixture(options = {}) {
  const windows = [];
  class MockProgressWindow {
    constructor(progressOptions) {
      this.options = progressOptions;
      this.items = [];
      this.showCount = 0;
      this.closeCount = 0;
      const owner = this;
      this.ItemProgress = class MockItemProgress {
        constructor(_icon, text) {
          this.text = text;
          this.progressValues = [];
          owner.items.push(this);
        }

        setText(text) {
          if (text === options.failOnText) {
            throw new Error("progress text failed");
          }
          this.text = text;
        }

        setProgress(value) {
          this.progressValues.push(value);
        }
      };
      windows.push(this);
    }

    changeHeadline(text) {
      this.headline = text;
    }

    show() {
      this.showCount++;
      return true;
    }

    close() {
      this.closeCount++;
    }
  }

  return {
    Zotero: { ProgressWindow: MockProgressWindow },
    windows,
  };
}

function createFakeTimers() {
  const timers = [];
  return {
    set(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clear(timer) {
      timer.cleared = true;
    },
    runNext() {
      const timer = timers.find((candidate) => !candidate.cleared && !candidate.ran);
      assert.ok(timer, "expected a pending timer");
      timer.ran = true;
      timer.callback();
    },
    pendingCount() {
      return timers.filter((timer) => !timer.cleared && !timer.ran).length;
    },
  };
}
