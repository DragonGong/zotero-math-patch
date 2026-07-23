const assert = require("node:assert/strict");
require("./helpers/setup-dom.js");

const {
  PROTECTED_CONTENT,
  extractSafeTextBlocks,
  prepareNoteHTML,
  filterUneditableInlineOperations,
  filterRedundantOperations,
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
  testReadonlyMathContextAndReconstruction();
  testRedundantOperationCoalescing();
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
  const readonlyBlock = blocks.find((block) => block.readonlyMath?.length);
  assert.equal(readonlyBlock.readonlyMath[0].latex, "existing");
  assert.equal(readonlyBlock.readonlyMath[0].kind, "inline");
  assert.equal(readonlyBlock.text.includes(readonlyBlock.readonlyMath[0].marker), true);
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
  assertCode(() => validateModelResponse({
    operations: [globallyCounted],
  }, crossBlockContext), "source_mismatch");
  assert.equal(
    applyModelOperations(crossBlockHTML, {
      operations: [inline("block-2", "(\\gamma=1)", 1, "\\gamma=1")],
    }).html,
    '<div class="zotero-note znv1"><p>Earlier (\\gamma=1).</p><p>Target <span class="math">$\\gamma=1$</span>.</p></div>',
  );

  const repeatedContext = prepareNoteHTML('<p>(x) and (x)</p>');
  assertCode(() => validateModelResponse({
    operations: [inline("block-1", "(x)", 3, "x")],
  }, repeatedContext), "source_mismatch");

  const shiftedHTML = '<p>Previous paragraph.</p><p>State value (V(G_k)) appears here.</p>';
  const shiftedContext = prepareNoteHTML(shiftedHTML);
  const shiftedBlock = inline("block-1", "(V(G_k))", 1, "V(G_k)");
  assertCode(() => validateModelResponse({
    operations: [shiftedBlock],
  }, shiftedContext), "source_mismatch");

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
      action: "replace",
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
      action: "replace",
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
      action: "replace",
      replacement: { type: "block", blockIds: ["block-1"], latex: casesLatex },
    },
    escapedContext,
    { operationIndex: 0, allowedBlockIds: ["block-1"] },
  ), "invalid_repair");
  assertCode(() => applyOperationRepair(
    { operations: [escapedSourceOperation] },
    {
      operationIndex: 1,
      action: "replace",
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
      action: "replace",
      replacement: { type: "block", blockIds: ["block-2"], latex: casesLatex },
    },
    escapedContext,
    { operationIndex: 0, allowedBlockIds: ["block-1"] },
  ), "unknown_block");

  const phantomContext = prepareNoteHTML(
    "<p>第 (i) 条轨迹前缀记为 (o_{i,\\le t})。</p><p>(s_{i,t}) is the score.</p>",
  );
  const validFirst = inline("block-1", "(i)", 1, "i");
  const phantom = inline("block-1", "(s_{i,t})", 1, "s_{i,t}");
  const validLast = inline("block-2", "(s_{i,t})", 1, "s_{i,t}");
  const removed = applyOperationRepair(
    { operations: [validFirst, phantom, validLast] },
    { operationIndex: 2, action: "remove", replacement: {} },
    phantomContext,
    { operationIndex: 1, allowedBlockIds: ["block-1", "block-2"] },
  );
  assert.deepEqual(removed.operations, [validFirst, validLast]);

  let replacementError;
  try {
    applyOperationRepair(
      { operations: [validFirst, phantom, validLast] },
      {
        operationIndex: 2,
        action: "replace",
        replacement: phantom,
      },
      phantomContext,
      { operationIndex: 1, allowedBlockIds: ["block-1", "block-2"] },
    );
  }
  catch (error) {
    replacementError = error;
  }
  assert.equal(replacementError?.operationIndex, 1);
  assert.match(replacementError?.message || "", /^Operation 2 /);
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

function testReadonlyMathContextAndReconstruction() {
  const html = [
    '<div class="zotero-note znv1">',
    "<h1>[<br>R_p(m;s_t)</h1>",
    '<p>\\alpha\\,\\mathrm{sim}(q_p(s_t),k_m)<br>+<br><span class="math">$1-\\alpha$</span><br>\\left[U(m)\\right]<br>]</p>',
    "</div>",
  ].join("");
  const context = prepareNoteHTML(html);
  const mixedBlock = context.blocks[1];
  const reference = mixedBlock.readonlyMath[0];
  assert.equal(reference.latex, "1-\\alpha");
  assert.match(mixedBlock.text, /READONLY_MATH:math-1/);

  const source = context.blocks.map((block) => block.text).join("\n");
  const normalized = {
    type: "block",
    blockIds: context.blocks.map((block) => block.id),
    source,
    latex: "R_p(m;s_t)=\\alpha\\,\\mathrm{sim}(q_p(s_t),k_m)+(1 - \\alpha)\\left[U(m)\\right]",
  };
  const unresolved = {
    ...normalized,
    latex: `R_p(m;s_t)=${reference.marker}`,
  };
  assertCode(
    () => validateModelResponse({ operations: [unresolved] }, context),
    "unresolved_math_reference",
  );

  const applied = applyModelOperations(html, { operations: [normalized] });
  assert.deepEqual(applied.stats, { inline: 0, block: 1 });
  assert.equal(applied.html.includes("READONLY_MATH"), false);
  assert.equal(applied.html.includes('<span class="math">'), false);
  assert.match(applied.html, /<pre class="math">\$\$R_p/);
  assert.match(applied.html, /1 - \\alpha/);

  const klHTML = '<h1>[<br>D^{\\mathrm{topK}}_{e,j}</h1><p>D_{\\mathrm{KL}}<span class="math">$q_{e,j}|p_{e,j}$</span><br>]</p>';
  const klContext = prepareNoteHTML(klHTML);
  const klResult = applyModelOperations(klHTML, {
    operations: [{
      type: "block",
      blockIds: klContext.blocks.map((block) => block.id),
      source: klContext.blocks.map((block) => block.text).join("\n"),
      latex: "D^{\\mathrm{topK}}_{e,j}=D_{\\mathrm{KL}}[q_{e,j}\\|p_{e,j}]",
    }],
  });
  assert.match(klResult.html, /q_\{e,j\}\\\|p_\{e,j\}/);

  const filtered = filterUneditableInlineOperations({
    operations: [
      inline(mixedBlock.id, reference.marker, 1, "1-\\alpha"),
      inline(context.blocks[0].id, "(m)", 1, "m"),
    ],
  }, context);
  assert.equal(filtered.removed.length, 1);
  assert.equal(filtered.removed[0].reason, "readonly_math");
  assert.deepEqual(filtered.payload.operations, [
    inline(context.blocks[0].id, "(m)", 1, "m"),
  ]);

  const hardHTML = '<p>Keep <span data-citation="secret">Citation</span> text</p>';
  const hardContext = prepareNoteHTML(hardHTML);
  assertCode(() => validateModelResponse({
    operations: [{
      type: "block",
      blockIds: ["block-1"],
      source: hardContext.blocks[0].text,
      latex: "x",
    }],
  }, hardContext), "protected_content");
}

function testRedundantOperationCoalescing() {
  const html = [
    '<div class="zotero-note znv1">',
    "<h1>[<br>R_p(m;s_t)</h1>",
    "<p>x<br>]</p>",
    "<p>Skill (m).</p>",
    "</div>",
  ].join("");
  const context = prepareNoteHTML(html);
  const inlineOperation = inline("block-1", "R_p(m;s_t)", 1, "R_p(m;s_t)");
  const blockOperation = {
    type: "block",
    blockIds: ["block-1", "block-2"],
    source: context.blocks.slice(0, 2).map((block) => block.text).join("\n"),
    latex: "R_p(m;s_t)=x",
  };
  const unrelatedOperation = inline("block-3", "(m)", 1, "m");
  const filtered = filterRedundantOperations({
    operations: [inlineOperation, blockOperation, unrelatedOperation],
  }, context);

  assert.equal(filtered.removed.length, 1);
  assert.equal(filtered.removed[0].reason, "covered_by_block_operation");
  assert.equal(filtered.removed[0].operationIndex, 1);
  assert.equal(filtered.removed[0].coveringOperationIndex, 2);
  assert.deepEqual(filtered.payload.operations, [blockOperation, unrelatedOperation]);
  assert.deepEqual(
    validateModelResponse(filtered.payload, context).stats,
    { inline: 1, block: 1 },
  );

  const trueConflict = filterRedundantOperations({
    operations: [
      inlineOperation,
      { ...blockOperation, latex: "Q=x" },
    ],
  }, context);
  assert.equal(trueConflict.removed.length, 0);
  assertCode(
    () => validateModelResponse(trueConflict.payload, context),
    "overlapping_operations",
  );

  const duplicate = filterRedundantOperations({
    operations: [unrelatedOperation, { ...unrelatedOperation }],
  }, context);
  assert.equal(duplicate.removed.length, 1);
  assert.equal(duplicate.removed[0].reason, "exact_duplicate");
  assert.deepEqual(duplicate.payload.operations, [unrelatedOperation]);
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
  const html = '<div class="zotero-note znv1"><p>Formula (d_i) and (v_i).</p><p><span data-citation="secret">Citation</span> protected</p><pre>code y=1</pre></div>';
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
      source: `Formula (d_i) and (v_i).\n${PROTECTED_CONTENT} protected`,
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
