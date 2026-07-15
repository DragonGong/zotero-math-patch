const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseHTML } = require("linkedom");

module.exports = async function runPreviewTests() {
  testWindowMarkup();
  testPreviewRenderingAndActions();
  console.log("preview tests passed");
};

function testWindowMarkup() {
  const xhtml = fs.readFileSync(
    path.join(__dirname, "../chrome/content/preview.xhtml"),
    "utf8",
  );
  const renderer = fs.readFileSync(
    path.join(__dirname, "../chrome/content/math-renderer.js"),
    "utf8",
  );

  assert.match(xhtml, /style="display: flex;"/);
  assert.match(xhtml, /onload="ZoteroMathPatchPreview\.init\(\)"/);
  assert.match(xhtml, /chrome:\/\/zotero\/content\/customElements\.js/);
  assert.match(xhtml, /id="zotero-math-patch-preview-apply"/);
  assert.match(xhtml, /id="zotero-math-patch-preview-cancel"/);
  assert.doesNotMatch(xhtml, /<dialog\b/);
  assert.match(renderer, /width=760,height=620/);
  assert.match(renderer, /chrome:\/\/zotero-math-patch\/content\/preview\.xhtml/);
  assert.doesNotMatch(renderer, /rootURI \+ "chrome\/content\/preview\.xhtml"/);
}

function testPreviewRenderingAndActions() {
  const operations = [
    { type: "inline", source: "(d_i)", latex: "d_i" },
    { type: "block", source: "[\nA / B\n]", latex: "\\frac{A}{B}" },
  ];
  const applyIO = {
    accepted: false,
    operations,
    stats: { inline: 1, block: 1 },
  };
  const applyPreview = createPreview(applyIO);

  assert.equal(
    applyPreview.document.getElementById("zotero-math-patch-preview-summary").textContent,
    "1 inline and 1 block formula(s) detected.",
  );
  const rows = applyPreview.document.getElementById("zotero-math-patch-preview-list").children;
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /InlineOriginal\(d_i\)LaTeXd_i/);
  assert.match(rows[1].textContent, /BlockOriginal\[\nA \/ B\n\]LaTeX\\frac\{A\}\{B\}/);

  applyPreview.document
    .getElementById("zotero-math-patch-preview-apply")
    .dispatchEvent(new applyPreview.window.Event("command"));
  assert.equal(applyIO.accepted, true);
  assert.equal(applyPreview.closeCount(), 1);

  const cancelIO = {
    accepted: true,
    operations: [operations[0]],
    stats: { inline: 1, block: 0 },
  };
  const cancelPreview = createPreview(cancelIO);
  cancelPreview.document
    .getElementById("zotero-math-patch-preview-cancel")
    .dispatchEvent(new cancelPreview.window.Event("command"));
  assert.equal(cancelIO.accepted, false);
  assert.equal(cancelPreview.closeCount(), 1);
}

function createPreview(io) {
  const { window, document } = parseHTML(`<!doctype html><html><body>
    <p id="zotero-math-patch-preview-summary"></p>
    <div id="zotero-math-patch-preview-list"></div>
    <button id="zotero-math-patch-preview-cancel"></button>
    <button id="zotero-math-patch-preview-apply"></button>
  </body></html>`);
  let closes = 0;
  window.arguments = [io];
  window.close = () => {
    closes++;
  };

  const hadWindow = Object.prototype.hasOwnProperty.call(global, "window");
  const previousWindow = global.window;
  const modulePath = require.resolve("../chrome/content/preview.js");
  global.window = window;
  delete require.cache[modulePath];
  try {
    const controller = require(modulePath);
    controller.init();
  }
  finally {
    if (hadWindow) {
      global.window = previousWindow;
    }
    else {
      delete global.window;
    }
    delete require.cache[modulePath];
  }

  return {
    window,
    document,
    closeCount: () => closes,
  };
}
