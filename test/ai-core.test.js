const assert = require("node:assert/strict");
require("./helpers/setup-dom.js");

const {
  PROTECTED_CONTENT,
  extractSafeTextBlocks,
  prepareNoteHTML,
  validateModelResponse,
  applyOperationRepair,
  applyModelOperations,
  createBatches,
  mergeBatchResults,
} = require("../chrome/content/ai-core.js");

module.exports = async function runAICoreTests() {
  testSafeExtraction();
  testInlineReplacementAndOccurrence();
  testBlockReplacement();
  testPermissiveMathSources();
  testLatexBraceValidation();
  testLatexComparisonValidation();
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

  const crossBlockHTML = '<div class="zotero-note znv1"><p>Earlier (\\gamma=1).</p><p>Target (\\gamma=1).</p></div>';
  const crossBlockContext = prepareNoteHTML(crossBlockHTML);
  const globallyCounted = inline("block-2", "(\\gamma=1)", 2, "\\gamma=1");
  const normalized = validateModelResponse({ operations: [globallyCounted] }, crossBlockContext);
  assert.equal(
    normalized.operations[0].occurrence,
    1,
    "a unique source in its block is safely normalized when the model counted prior blocks",
  );
  assert.equal(
    applyModelOperations(crossBlockHTML, { operations: [globallyCounted] }).html,
    '<div class="zotero-note znv1"><p>Earlier (\\gamma=1).</p><p>Target <span class="math">$\\gamma=1$</span>.</p></div>',
  );

  const repeatedContext = prepareNoteHTML('<p>(x) and (x)</p>');
  assertCode(() => validateModelResponse({
    operations: [inline("block-1", "(x)", 3, "x")],
  }, repeatedContext), "source_mismatch");

  const shiftedHTML = '<p>Previous paragraph.</p><p>State value (V(G_k)) appears here.</p>';
  const shiftedContext = prepareNoteHTML(shiftedHTML);
  const shiftedBlock = inline("block-1", "(V(G_k))", 1, "V(G_k)");
  const relocated = validateModelResponse({ operations: [shiftedBlock] }, shiftedContext);
  assert.equal(
    relocated.operations[0].blockId,
    "block-2",
    "a wrong blockId is safely relocated when source has one exact editable match in the batch",
  );
  assert.equal(
    applyModelOperations(shiftedHTML, { operations: [shiftedBlock] }).html,
    '<p>Previous paragraph.</p><p>State value <span class="math">$V(G_k)$</span> appears here.</p>',
  );

  const ambiguousContext = prepareNoteHTML('<p>Wrong block.</p><p>(x)</p><p>(x)</p>');
  assertCode(() => validateModelResponse({
    operations: [inline("block-1", "(x)", 1, "x")],
  }, ambiguousContext), "source_mismatch");
  assertCode(() => validateModelResponse({
    operations: [inline("block-1", "(V(G_k))", 1, "V(G_k)")],
  }, shiftedContext, { allowedBlockIds: ["block-1"] }), "source_mismatch");
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

  const slash = "\\";
  const casesSource = [
    "[",
    "R=",
    slash + "begin{cases}",
    slash + "text{Acc}+r_M,&" + slash + "text{格式正确且答案正确}" + slash,
    "0,&" + slash + "text{格式正确但答案错误}" + slash,
    "-1,&" + slash + "text{格式错误}",
    slash + "end{cases}",
    "]",
  ].join("\n");
  const escapedCasesSource = casesSource
    .split(slash + "\n")
    .join(slash + slash + "n");
  const casesLatex = "R=\\begin{cases}\\text{Acc}+r_M,&\\text{格式正确且答案正确}\\\\0,&\\text{格式正确但答案错误}\\\\-1,&\\text{格式错误}\\end{cases}";
  const escapedSourceOperation = {
    type: "block",
    blockIds: ["block-1"],
    source: escapedCasesSource,
    latex: casesLatex,
  };
  const escapedContext = prepareNoteHTML(`<p>${casesSource}</p>`);
  let sourceError;
  try {
    validateModelResponse({ operations: [escapedSourceOperation] }, escapedContext);
  }
  catch (error) {
    sourceError = error;
  }
  assert.equal(sourceError?.code, "source_mismatch");
  assert.equal(sourceError?.operationIndex, 0);

  const repairedPayload = applyOperationRepair(
    { operations: [escapedSourceOperation] },
    {
      operationIndex: 1,
      replacement: {
        type: "block",
        blockIds: ["block-1"],
        latex: casesLatex,
      },
    },
    escapedContext,
    { operationIndex: 0, allowedBlockIds: ["block-1"] },
  );
  assert.equal(
    repairedPayload.operations[0].source,
    casesSource,
    "a model-confirmed block repair receives canonical source directly from the note DOM",
  );
  assert.equal(
    applyModelOperations(`<p>${casesSource}</p>`, repairedPayload).stats.block,
    1,
  );

  assertCode(() => applyOperationRepair(
    { operations: [escapedSourceOperation] },
    {
      operationIndex: 1,
      replacement: [{
        type: "block",
        blockIds: ["block-1"],
        latex: casesLatex,
      }],
    },
    escapedContext,
    { operationIndex: 0, allowedBlockIds: ["block-1"] },
  ), "invalid_schema");

  assertCode(() => applyOperationRepair(
    { operations: [escapedSourceOperation] },
    {
      operationIndex: 2,
      replacement: { type: "block", blockIds: ["block-1"], latex: casesLatex },
    },
    escapedContext,
    { operationIndex: 0, allowedBlockIds: ["block-1"] },
  ), "invalid_repair");
  assertCode(() => applyOperationRepair(
    { operations: [escapedSourceOperation] },
    {
      operationIndex: 1,
      replacement: {
        type: "block",
        blockIds: ["block-1"],
        source: casesSource,
        latex: casesLatex,
      },
    },
    escapedContext,
    { operationIndex: 0, allowedBlockIds: ["block-1"] },
  ), "invalid_schema");
  assertCode(() => applyOperationRepair(
    { operations: [escapedSourceOperation] },
    {
      operationIndex: 1,
      replacement: { type: "block", blockIds: ["block-2"], latex: casesLatex },
    },
    escapedContext,
    { operationIndex: 0, allowedBlockIds: ["block-1"] },
  ), "unknown_block");
}

function testPermissiveMathSources() {
  const numericResult = applyModelOperations(
    '<div class="zotero-note znv1"><p>[</p><p>[0,0,0,0,0,0]</p><p>]</p></div>',
    {
      operations: [{
        type: "block",
        blockIds: ["block-1", "block-2", "block-3"],
        source: "[\n[0,0,0,0,0,0]\n]",
        latex: "\\left[0,0,0,0,0,0\\right]",
      }],
    },
  );

  assert.equal(
    numericResult.html,
    '<div class="zotero-note znv1"><pre class="math">$$\\left[0,0,0,0,0,0\\right]$$</pre></div>',
  );

  const sources = ["0", "2026", "0,0,0,0", "x", "TTC", "f(x)", "(a,b,c)", "Formula"];
  const html = `<div class="zotero-note znv1">${sources.map((source) => `<p>${source}</p>`).join("")}</div>`;
  const result = applyModelOperations(html, {
    operations: sources.map((source, index) => inline(`block-${index + 1}`, source, 1, source)),
  });

  assert.deepEqual(result.stats, { inline: sources.length, block: 0 });
  for (const source of sources) {
    assert.ok(
      result.html.includes(`<p><span class="math">$${source}$</span></p>`),
      `model-selected source is accepted without local math semantics: ${source}`,
    );
  }
}

function testLatexBraceValidation() {
  const sourceLatex = String.raw`\text{最差任务性能}\quad\text{和}\quad\text{平均性能}`;
  const html = `<div class="zotero-note znv1"><p>[</p><p>${sourceLatex}</p><p>]</p></div>`;
  const context = prepareNoteHTML(html);
  const blockOperation = {
    type: "block",
    blockIds: ["block-1", "block-2", "block-3"],
    source: `[\n${sourceLatex}\n]`,
    latex: sourceLatex.slice(0, -1),
  };

  assertCode(() => validateModelResponse({ operations: [blockOperation] }, context), "invalid_latex");
  assertCode(() => validateModelResponse({
    operations: [{ ...blockOperation, latex: sourceLatex + "}" }],
  }, context), "invalid_latex");
  assertCode(() => applyModelOperations(html, { operations: [blockOperation] }), "invalid_latex");

  const valid = validateModelResponse({
    operations: [{
      ...blockOperation,
      latex: String.raw`\left\{\text{集合 \{x\}}\right\}`,
    }],
  }, context);
  assert.equal(valid.operations.length, 1, "escaped literal braces remain valid LaTeX");
}

function testLatexComparisonValidation() {
  const html = '<div class="zotero-note znv1"><p>piecewise formula</p></div>';
  const context = prepareNoteHTML(html);
  const casesLatex = String.raw`\hat A_i=\begin{cases}\alpha_{\text{low}}A_i,&A_i>0,\ \mathcal H_g<H_{\text{low}}\\[2mm]\alpha_{\text{high}}A_i,&A_i<0,\ \mathcal H_g>H_{\text{high}}\\A_i,&\text{其他情况}\end{cases}`;
  const comparisonLatex = String.raw`a<b>c`;

  const casesResult = validateModelResponse({
    operations: [inline("block-1", "piecewise formula", 1, casesLatex)],
  }, context);
  assert.equal(casesResult.operations[0].latex, casesLatex);
  assert.doesNotThrow(() => validateModelResponse({
    operations: [inline("block-1", "piecewise formula", 1, comparisonLatex)],
  }, context), "mathematical less-than and greater-than signs are not treated as HTML");

  const applied = applyModelOperations(html, {
    operations: [inline("block-1", "piecewise formula", 1, casesLatex)],
  });
  assert.match(applied.html, /mathcal H_g&lt;H_/);
  assert.match(applied.html, /\\end\{cases\}/);
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
    operations: [inline("block-1", "(d_i)", 1, "<!--not latex-->")],
  }, context), "unsafe_latex");
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
