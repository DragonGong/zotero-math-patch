const assert = require("node:assert/strict");
require("./helpers/setup-dom.js");

const {
  PROTECTED_CONTENT,
  extractSafeTextBlocks,
  prepareNoteHTML,
  validateModelResponse,
  applyModelOperations,
  createBatches,
  mergeBatchResults,
} = require("../chrome/content/ai-core.js");

module.exports = async function runAICoreTests() {
  testSafeExtraction();
  testInlineReplacementAndOccurrence();
  testBlockReplacement();
  testFormattingPreservation();
  testValidationFailures();
  testBatchingAndMerging();
  console.log("AI core tests passed");
};

function testSafeExtraction() {
  const html = [
    '<div class="zotero-note znv1">',
    "<h1>Heading</h1>",
    "<p>where <strong>(d_i)</strong> is distance</p>",
    "<pre>secret code x=1</pre>",
    '<p>before <span class="math">$existing$</span> after</p>',
    '<p><code>inline code y=2</code> tail</p>',
    '<p><a href="https://example.com">linked z=3</a> outside (v_i)</p>',
    '<p><span data-citation="private citation">Citation</span> context</p>',
    '<p><img data-attachment-key="ABC" alt="attachment"/> caption</p>',
    "<script>private script</script><style>.private{}</style>",
    "</div>",
  ].join("");
  const blocks = extractSafeTextBlocks(html);
  const sent = JSON.stringify(blocks);
  assert.deepEqual(blocks.slice(0, 2), [
    { id: "block-1", tag: "h1", text: "Heading" },
    { id: "block-2", tag: "p", text: "where (d_i) is distance" },
  ]);
  assert.equal(sent.includes("secret code"), false, "code blocks are not sent");
  assert.equal(sent.includes("$existing$"), false, "existing math is not sent");
  assert.equal(sent.includes("inline code"), false, "inline code is not sent");
  assert.equal(sent.includes("linked z=3"), false, "link contents are not sent");
  assert.equal(sent.includes("private citation"), false, "Zotero citation payload is not sent");
  assert.equal(sent.includes("attachment"), false, "attachment metadata is not sent");
  assert.equal(sent.includes("private script"), false);
  assert.ok(blocks.some((block) => block.text.includes(PROTECTED_CONTENT)));
}

function testInlineReplacementAndOccurrence() {
  const html = '<div class="zotero-note znv1"><p>First (d_i), second (d_i), speed (v_i).</p></div>';
  const result = applyModelOperations(html, {
    operations: [
      inline("block-1", "(d_i)", 1, "d_1"),
      inline("block-1", "(d_i)", 2, "d_2"),
      inline("block-1", "(v_i)", 1, "v_i"),
    ],
  });
  assert.deepEqual(result.stats, { inline: 3, block: 0 });
  assert.equal(
    result.html,
    '<div class="zotero-note znv1"><p>First <span class="math">$d_1$</span>, second <span class="math">$d_2$</span>, speed <span class="math">$v_i$</span>.</p></div>',
  );
}

function testBlockReplacement() {
  const html = '<div class="zotero-note znv1"><p>[</p><p><strong>TTCP_i = d_i / v_i</strong></p><p>]</p><p>Keep me</p></div>';
  const result = applyModelOperations(html, {
    operations: [{
      type: "block",
      blockIds: ["block-1", "block-2", "block-3"],
      source: "[\nTTCP_i = d_i / v_i\n]",
      latex: "TTCP_i = \\frac{d_i}{v_i}",
    }],
  });
  assert.deepEqual(result.stats, { inline: 0, block: 1 });
  assert.equal(
    result.html,
    '<div class="zotero-note znv1"><pre class="math">$$TTCP_i = \\frac{d_i}{v_i}$$</pre><p>Keep me</p></div>',
  );

  const single = applyModelOperations('<p>[<br>x_i = 1<br>]</p>', {
    operations: [{
      type: "block",
      blockIds: ["block-1"],
      source: "[\nx_i = 1\n]",
      latex: "x_i = 1",
    }],
  });
  assert.equal(single.html, '<pre class="math">$$x_i = 1$$</pre>');
}

function testFormattingPreservation() {
  const html = '<div class="zotero-note znv1"><h2>Title</h2><p>Before <strong>(d_i)</strong> and <em>unchanged</em> <a href="https://example.com">link x=1</a>.</p><ul><li>List (v_i)</li></ul><blockquote>Quote</blockquote><p><span class="math">$x$</span></p></div>';
  const context = prepareNoteHTML(html);
  const paragraph = context.blocks.find((block) => block.text.includes("(d_i)"));
  const list = context.blocks.find((block) => block.text.includes("(v_i)"));
  const result = applyModelOperations(html, {
    operations: [
      inline(paragraph.id, "(d_i)", 1, "d_i"),
      inline(list.id, "(v_i)", 1, "v_i"),
    ],
  });
  assert.match(result.html, /<h2>Title<\/h2>/);
  assert.match(result.html, /<strong><span class="math">\$d_i\$<\/span><\/strong>/);
  assert.match(result.html, /<em>unchanged<\/em>/);
  assert.match(result.html, /<a href="https:\/\/example.com">link x=1<\/a>/);
  assert.match(result.html, /<ul><li>List <span class="math">\$v_i\$<\/span><\/li><\/ul>/);
  assert.match(result.html, /<blockquote>Quote<\/blockquote>/);
  assert.match(result.html, /<p><span class="math">\$x\$<\/span><\/p>/);
}

function testValidationFailures() {
  const html = '<div class="zotero-note znv1"><p>Formula (d_i) and (v_i).</p><p><span class="math">$x$</span> protected</p><pre>code y=1</pre></div>';
  const context = prepareNoteHTML(html);
  assertCode(() => validateModelResponse("not json", context), "invalid_json");
  assertCode(() => validateModelResponse({}, context), "invalid_schema");
  assertCode(() => validateModelResponse({ operations: [{ type: "inline" }] }, context), "invalid_schema");
  assertCode(() => validateModelResponse({
    operations: [inline("block-999", "(d_i)", 1, "d_i")],
  }, context), "unknown_block");
  assertCode(() => validateModelResponse({
    operations: [inline("block-1", "(missing_i)", 1, "d_i")],
  }, context), "source_mismatch");
  assertCode(() => validateModelResponse({
    operations: [
      inline("block-1", "(d_i)", 1, "d_i"),
      inline("block-1", "(d_i)", 1, "d_2"),
    ],
  }, context), "overlapping_operations");
  assertCode(() => validateModelResponse({
    operations: [inline("block-1", "(d_i)", 1, "")],
  }, context), "invalid_latex");
  assertCode(() => validateModelResponse({
    operations: [inline("block-1", "(d_i)", 1, "<img src=x>")],
  }, context), "unsafe_latex");
  assertCode(() => validateModelResponse({
    operations: [inline("block-1", "Formula", 1, "x")],
  }, context), "not_math");
  assertCode(() => validateModelResponse({
    operations: [inline("block-2", "$x$", 1, "x")],
  }, context), "source_mismatch");
  assertCode(() => validateModelResponse({ html: "<p>replacement</p>", operations: [] }, context), "invalid_schema");
  assertCode(() => validateModelResponse({
    operations: [{
      type: "block",
      blockIds: ["block-1", "block-2"],
      source: "Formula (d_i) and (v_i).\nprotected",
      latex: "x",
    }],
  }, context), "protected_content");

  const original = html;
  assertCode(() => applyModelOperations(original, {
    operations: [inline("block-1", "(d_i)", 1, "<script>x</script>")],
  }), "unsafe_latex");
  assert.equal(html, original, "validation failure leaves the original note string untouched");
}

function testBatchingAndMerging() {
  const html = '<div class="zotero-note znv1">'
    + Array.from({ length: 8 }, (_, index) => `<p>Context ${index} formula (x_${index})</p>`).join("")
    + "</div>";
  const context = prepareNoteHTML(html);
  const batches = createBatches(context.blocks, 220, 1);
  assert.ok(batches.length > 1, "long notes are split at block boundaries");
  assert.deepEqual(
    [...new Set(batches.flatMap((batch) => batch.blocks.map((block) => block.id)))],
    context.blocks.map((block) => block.id),
    "original block IDs survive batching",
  );
  assertCode(() => createBatches([
    { id: "block-1", tag: "p", text: "x".repeat(500) },
  ], 200), "block_too_large");

  const operation = inline("block-2", "(x_1)", 1, "x_1");
  const deduped = mergeBatchResults([
    { payload: { operations: [operation] }, allowedBlockIds: ["block-1", "block-2"] },
    { payload: { operations: [operation] }, allowedBlockIds: ["block-2", "block-3"] },
  ], context);
  assert.equal(deduped.operations.length, 1, "identical overlap-context operations are deduplicated");

  assertCode(() => mergeBatchResults([
    { payload: { operations: [operation] }, allowedBlockIds: ["block-1", "block-2"] },
    {
      payload: { operations: [inline("block-2", "(x_1)", 1, "x_{different}")] },
      allowedBlockIds: ["block-2", "block-3"],
    },
  ], context), "overlapping_operations");
  assertCode(() => mergeBatchResults([
    { payload: { operations: [inline("block-8", "(x_7)", 1, "x_7")] }, allowedBlockIds: ["block-1"] },
  ], context), "out_of_batch");
}

function inline(blockId, source, occurrence, latex) {
  return { type: "inline", blockId, source, occurrence, latex };
}

function assertCode(callback, expectedCode) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, expectedCode, error.message);
    return true;
  });
}
