(function (global) {
  "use strict";

  const PROTECTED_CONTENT = "\uFFFC";
  const MAX_OPERATIONS = 200;
  const MAX_SOURCE_LENGTH = 20000;
  const MAX_LATEX_LENGTH = 10000;
  const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, blockquote, div";
  const PROTECTED_TAGS = new Set([
    "A",
    "AUDIO",
    "CODE",
    "IFRAME",
    "IMG",
    "OBJECT",
    "PRE",
    "SCRIPT",
    "STYLE",
    "VIDEO",
  ]);

  class AIValidationError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "AIValidationError";
      this.code = code;
    }
  }

  function extractSafeTextBlocks(html) {
    return prepareNoteHTML(html).blocks.map(copyPublicBlock);
  }

  function prepareNoteHTML(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(html || ""), "text/html");
    doc.body.normalize();

    const candidateNodes = Array.from(doc.body.querySelectorAll(BLOCK_SELECTOR))
      .filter((node) => !isInsideProtectedContent(node));
    const candidateSet = new Set(candidateNodes);
    const records = [];

    for (const node of candidateNodes) {
      const record = buildBlockRecord(node, candidateSet);
      const editableText = record.text.split(PROTECTED_CONTENT).join("").trim();
      if (!editableText) {
        continue;
      }
      record.id = "block-" + (records.length + 1);
      record.index = records.length;
      records.push(record);
    }

    const recordByID = new Map(records.map((record) => [record.id, record]));
    return {
      doc,
      blocks: records.map(copyPublicBlock),
      records,
      recordByID,
    };
  }

  function buildBlockRecord(node, candidateSet) {
    let text = "";
    const segments = [];
    let hasNestedBlock = false;

    function appendSegment(type, value, sourceNode = null) {
      if (!value) {
        return;
      }
      const start = text.length;
      text += value;
      segments.push({
        type,
        start,
        end: text.length,
        node: sourceNode,
      });
    }

    function walk(current, isRoot) {
      if (current.nodeType === 3) {
        appendSegment("text", current.nodeValue || "", current);
        return;
      }
      if (current.nodeType !== 1) {
        return;
      }
      if (!isRoot && candidateSet.has(current)) {
        hasNestedBlock = true;
        appendProtectedBoundary();
        return;
      }
      if (!isRoot && isProtectedElement(current)) {
        appendProtectedBoundary();
        return;
      }
      if (current.tagName === "BR") {
        appendSegment("break", "\n", current);
        return;
      }
      for (const child of Array.from(current.childNodes || [])) {
        walk(child, false);
      }
    }

    function appendProtectedBoundary() {
      if (!text.endsWith(PROTECTED_CONTENT)) {
        appendSegment("protected", PROTECTED_CONTENT);
      }
    }

    walk(node, true);
    return {
      id: "",
      index: -1,
      tag: String(node.tagName || "").toLowerCase(),
      text,
      node,
      segments,
      allowBlockReplacement: !hasNestedBlock && !node.classList?.contains("zotero-note"),
    };
  }

  function validateModelResponse(payload, context, options = {}) {
    const parsed = parseModelPayload(payload);
    assertPlainObject(parsed, "The model response must be a JSON object.");
    assertExactKeys(parsed, ["operations"], "The top-level response contains unsupported fields.");
    if (!Array.isArray(parsed.operations)) {
      throw validationError("invalid_schema", "The top-level operations field must be an array.");
    }
    if (parsed.operations.length > MAX_OPERATIONS) {
      throw validationError("too_many_operations", `The model returned more than ${MAX_OPERATIONS} operations.`);
    }

    const allowedBlockIDs = options.allowedBlockIds
      ? new Set(options.allowedBlockIds)
      : null;
    const operations = [];
    const metadata = [];
    const coverageByBlock = new Map();

    parsed.operations.forEach((operation, operationIndex) => {
      assertPlainObject(operation, `Operation ${operationIndex + 1} must be an object.`);
      if (operation.type === "inline") {
        const result = validateInlineOperation(operation, context, allowedBlockIDs, operationIndex);
        operations.push(result.operation);
        metadata.push(result.metadata);
        addCoverage(result.metadata.coverage, coverageByBlock, operationIndex);
        return;
      }
      if (operation.type === "block") {
        const result = validateBlockOperation(operation, context, allowedBlockIDs, operationIndex);
        operations.push(result.operation);
        metadata.push(result.metadata);
        for (const coverage of result.metadata.coverage) {
          addCoverage(coverage, coverageByBlock, operationIndex);
        }
        return;
      }
      throw validationError("invalid_type", `Operation ${operationIndex + 1} has an invalid type.`);
    });

    return {
      operations,
      metadata,
      stats: countOperations(operations),
    };
  }

  function parseModelPayload(payload) {
    if (typeof payload !== "string") {
      return payload;
    }
    try {
      return JSON.parse(payload);
    }
    catch (_error) {
      throw validationError("invalid_json", "The model response is not valid JSON.");
    }
  }

  function validateInlineOperation(operation, context, allowedBlockIDs, operationIndex) {
    assertExactKeys(
      operation,
      ["type", "blockId", "source", "occurrence", "latex"],
      `Inline operation ${operationIndex + 1} has missing or unsupported fields.`,
    );
    assertString(operation.blockId, "blockId", operationIndex);
    assertString(operation.source, "source", operationIndex);
    const latex = validateLatex(operation.latex, operationIndex);
    if (!Number.isInteger(operation.occurrence) || operation.occurrence < 1) {
      throw validationError("invalid_occurrence", `Operation ${operationIndex + 1} occurrence must be a positive integer.`);
    }
    if (!operation.source || operation.source.length > MAX_SOURCE_LENGTH) {
      throw validationError("invalid_source", `Operation ${operationIndex + 1} has an empty or oversized source.`);
    }
    if (operation.source.includes(PROTECTED_CONTENT)) {
      throw validationError("protected_content", `Operation ${operationIndex + 1} targets protected note content.`);
    }
    if (!looksLikeMathSource(operation.source, "inline")) {
      throw validationError("not_math", `Operation ${operationIndex + 1} source does not look like a mathematical expression.`);
    }

    const record = getRecord(context, operation.blockId, allowedBlockIDs, operationIndex);
    const range = findOccurrenceRange(record.text, operation.source, operation.occurrence);
    if (!range) {
      throw validationError("source_mismatch", `Operation ${operationIndex + 1} source and occurrence do not match the original block.`);
    }
    if (!rangeIsEditable(record, range.start, range.end)) {
      throw validationError("protected_content", `Operation ${operationIndex + 1} crosses protected or non-text content.`);
    }

    return {
      operation: {
        type: "inline",
        blockId: operation.blockId,
        source: operation.source,
        occurrence: operation.occurrence,
        latex,
      },
      metadata: {
        type: "inline",
        record,
        start: range.start,
        end: range.end,
        coverage: {
          blockId: record.id,
          start: range.start,
          end: range.end,
        },
      },
    };
  }

  function validateBlockOperation(operation, context, allowedBlockIDs, operationIndex) {
    assertExactKeys(
      operation,
      ["type", "blockIds", "source", "latex"],
      `Block operation ${operationIndex + 1} has missing or unsupported fields.`,
    );
    if (!Array.isArray(operation.blockIds) || !operation.blockIds.length) {
      throw validationError("invalid_block_ids", `Operation ${operationIndex + 1} blockIds must be a non-empty array.`);
    }
    if (operation.blockIds.some((id) => typeof id !== "string")) {
      throw validationError("invalid_block_ids", `Operation ${operationIndex + 1} blockIds must contain strings only.`);
    }
    if (new Set(operation.blockIds).size !== operation.blockIds.length) {
      throw validationError("invalid_block_ids", `Operation ${operationIndex + 1} repeats a blockId.`);
    }
    assertString(operation.source, "source", operationIndex);
    const latex = validateLatex(operation.latex, operationIndex);
    if (!operation.source || operation.source.length > MAX_SOURCE_LENGTH) {
      throw validationError("invalid_source", `Operation ${operationIndex + 1} has an empty or oversized source.`);
    }
    if (operation.source.includes(PROTECTED_CONTENT)) {
      throw validationError("protected_content", `Operation ${operationIndex + 1} targets protected note content.`);
    }
    if (!looksLikeMathSource(operation.source, "block")) {
      throw validationError("not_math", `Operation ${operationIndex + 1} source does not look like a standalone mathematical expression.`);
    }

    const records = operation.blockIds.map((id) => getRecord(context, id, allowedBlockIDs, operationIndex));
    for (const record of records) {
      if (!record.allowBlockReplacement || record.text.includes(PROTECTED_CONTENT)) {
        throw validationError("protected_content", `Operation ${operationIndex + 1} cannot replace this block safely.`);
      }
    }
    for (let i = 1; i < records.length; i++) {
      if (records[i].index !== records[i - 1].index + 1 || !areAdjacentSiblingBlocks(records[i - 1], records[i])) {
        throw validationError("non_contiguous_blocks", `Operation ${operationIndex + 1} blockIds are not contiguous sibling blocks.`);
      }
    }

    const exactSource = records.map((record) => record.text).join("\n");
    if (operation.source !== exactSource) {
      throw validationError("source_mismatch", `Operation ${operationIndex + 1} source does not exactly match its blocks.`);
    }

    return {
      operation: {
        type: "block",
        blockIds: operation.blockIds.slice(),
        source: operation.source,
        latex,
      },
      metadata: {
        type: "block",
        records,
        coverage: records.map((record) => ({
          blockId: record.id,
          start: 0,
          end: record.text.length,
        })),
      },
    };
  }

  function applyModelOperations(html, payload) {
    const context = prepareNoteHTML(html);
    const validation = validateModelResponse(payload, context);
    const work = validation.metadata.map((metadata, index) => ({
      metadata,
      operation: validation.operations[index],
    }));

    work.sort((left, right) => {
      const leftIndex = left.metadata.type === "inline"
        ? left.metadata.record.index
        : left.metadata.records[left.metadata.records.length - 1].index;
      const rightIndex = right.metadata.type === "inline"
        ? right.metadata.record.index
        : right.metadata.records[right.metadata.records.length - 1].index;
      if (leftIndex !== rightIndex) {
        return rightIndex - leftIndex;
      }
      const leftStart = left.metadata.type === "inline" ? left.metadata.start : 0;
      const rightStart = right.metadata.type === "inline" ? right.metadata.start : 0;
      return rightStart - leftStart;
    });

    for (const item of work) {
      if (item.metadata.type === "inline") {
        replaceInlineRange(context.doc, item.metadata, item.operation.latex);
      }
      else {
        replaceBlockRecords(context.doc, item.metadata.records, item.operation.latex);
      }
    }

    return {
      html: context.doc.body.innerHTML,
      operations: validation.operations,
      stats: validation.stats,
      changed: validation.operations.length > 0,
    };
  }

  function replaceInlineRange(doc, metadata, latex) {
    const { record, start, end } = metadata;
    const textSegments = record.segments.filter((segment) => segment.type === "text");
    const startSegmentIndex = textSegments.findIndex(
      (segment) => segment.start <= start && start < segment.end,
    );
    const endSegmentIndex = textSegments.findIndex(
      (segment) => segment.start < end && end <= segment.end,
    );
    if (startSegmentIndex === -1 || endSegmentIndex === -1) {
      throw validationError("apply_failed", "An inline formula could not be mapped back to the note DOM.");
    }

    const startSegment = textSegments[startSegmentIndex];
    const endSegment = textSegments[endSegmentIndex];
    const startNode = startSegment.node;
    const endNode = endSegment.node;
    const startOffset = start - startSegment.start;
    const endOffset = end - endSegment.start;
    const math = doc.createElement("span");
    math.className = "math";
    math.textContent = "$" + latex + "$";

    if (startNode === endNode) {
      const original = startNode.nodeValue || "";
      const before = original.slice(0, startOffset);
      const after = original.slice(endOffset);
      startNode.nodeValue = before;
      insertAfter(startNode.parentNode, math, startNode);
      if (after) {
        insertAfter(math.parentNode, doc.createTextNode(after), math);
      }
      return;
    }

    startNode.nodeValue = (startNode.nodeValue || "").slice(0, startOffset);
    insertAfter(startNode.parentNode, math, startNode);
    for (let i = startSegmentIndex + 1; i < endSegmentIndex; i++) {
      textSegments[i].node.nodeValue = "";
    }
    endNode.nodeValue = (endNode.nodeValue || "").slice(endOffset);
  }

  function replaceBlockRecords(doc, records, latex) {
    const first = records[0].node;
    const parent = first.parentNode;
    const math = doc.createElement("pre");
    math.className = "math";
    math.textContent = "$$" + latex + "$$";
    parent.insertBefore(math, first);
    for (const record of records) {
      record.node.parentNode.removeChild(record.node);
    }
  }

  function createBatches(blocks, maxChars, contextSize = 1) {
    const sourceBlocks = Array.isArray(blocks) ? blocks.map(copyPublicBlock) : [];
    if (!sourceBlocks.length) {
      return [];
    }
    const limit = Number.parseInt(maxChars, 10);
    if (!Number.isFinite(limit) || limit < 100) {
      throw validationError("invalid_batch_size", "The maximum request character setting is invalid.");
    }

    const costs = sourceBlocks.map((block) => JSON.stringify(block).length + 2);
    const overhead = 64;
    const groups = [];
    let start = 0;
    while (start < sourceBlocks.length) {
      if (costs[start] + overhead > limit) {
        throw validationError(
          "block_too_large",
          `${sourceBlocks[start].id} exceeds the configured maximum request characters.`,
        );
      }
      let end = start;
      let cost = overhead;
      while (end < sourceBlocks.length && cost + costs[end] <= limit) {
        cost += costs[end];
        end++;
      }
      groups.push({ start, end, cost });
      start = end;
    }

    const overlap = Math.max(0, Number.parseInt(contextSize, 10) || 0);
    return groups.map((group, index) => {
      const indices = [];
      let total = group.cost;
      for (let i = group.start; i < group.end; i++) {
        indices.push(i);
      }
      for (let step = 1; step <= overlap; step++) {
        const previous = group.start - step;
        if (previous >= 0 && total + costs[previous] <= limit) {
          indices.push(previous);
          total += costs[previous];
        }
        const next = group.end - 1 + step;
        if (next < sourceBlocks.length && total + costs[next] <= limit) {
          indices.push(next);
          total += costs[next];
        }
      }
      indices.sort((a, b) => a - b);
      const batchBlocks = indices.map((itemIndex) => sourceBlocks[itemIndex]);
      return {
        id: "batch-" + (index + 1),
        blocks: batchBlocks,
        primaryBlockIds: sourceBlocks
          .slice(group.start, group.end)
          .map((block) => block.id),
        allowedBlockIds: batchBlocks.map((block) => block.id),
      };
    });
  }

  function mergeBatchResults(batchResults, context) {
    const unique = new Map();
    for (const result of batchResults || []) {
      const validation = validateModelResponse(result.payload, context, {
        allowedBlockIds: result.allowedBlockIds,
      });
      for (const operation of validation.operations) {
        unique.set(operationKey(operation), operation);
      }
    }
    return validateModelResponse({ operations: Array.from(unique.values()) }, context);
  }

  function operationKey(operation) {
    if (operation.type === "inline") {
      return JSON.stringify([
        operation.type,
        operation.blockId,
        operation.source,
        operation.occurrence,
        operation.latex,
      ]);
    }
    return JSON.stringify([
      operation.type,
      operation.blockIds,
      operation.source,
      operation.latex,
    ]);
  }

  function getRecord(context, blockID, allowedBlockIDs, operationIndex) {
    const record = context?.recordByID?.get(blockID);
    if (!record) {
      throw validationError("unknown_block", `Operation ${operationIndex + 1} references an unknown blockId.`);
    }
    if (allowedBlockIDs && !allowedBlockIDs.has(blockID)) {
      throw validationError("out_of_batch", `Operation ${operationIndex + 1} references a block outside its request batch.`);
    }
    return record;
  }

  function findOccurrenceRange(text, source, occurrence) {
    let offset = 0;
    let found = -1;
    for (let count = 0; count < occurrence; count++) {
      found = text.indexOf(source, offset);
      if (found === -1) {
        return null;
      }
      offset = found + source.length;
    }
    return { start: found, end: found + source.length };
  }

  function rangeIsEditable(record, start, end) {
    let position = start;
    while (position < end) {
      const segment = record.segments.find(
        (candidate) => candidate.start <= position && position < candidate.end,
      );
      if (!segment || segment.type !== "text") {
        return false;
      }
      position = Math.min(end, segment.end);
    }
    return position === end;
  }

  function addCoverage(coverage, coverageByBlock, operationIndex) {
    const existing = coverageByBlock.get(coverage.blockId) || [];
    for (const previous of existing) {
      if (Math.max(previous.start, coverage.start) < Math.min(previous.end, coverage.end)) {
        throw validationError(
          "overlapping_operations",
          `Operation ${operationIndex + 1} overlaps another model operation.`,
        );
      }
    }
    existing.push(coverage);
    coverageByBlock.set(coverage.blockId, existing);
  }

  function validateLatex(latex, operationIndex) {
    if (typeof latex !== "string") {
      throw validationError("invalid_latex", `Operation ${operationIndex + 1} latex must be a string.`);
    }
    const normalized = latex.trim();
    if (!normalized || normalized.length > MAX_LATEX_LENGTH) {
      throw validationError("invalid_latex", `Operation ${operationIndex + 1} latex is empty or oversized.`);
    }
    if (normalized.includes("$") || /<\s*\/?\s*[A-Za-z][^>]*>/.test(normalized)) {
      throw validationError("unsafe_latex", `Operation ${operationIndex + 1} latex contains delimiters or HTML.`);
    }
    if (/\\(?:htmlClass|htmlId|htmlStyle|href|url|includegraphics)\b/i.test(normalized)) {
      throw validationError("unsafe_latex", `Operation ${operationIndex + 1} latex contains a disallowed command.`);
    }
    return normalized;
  }

  function looksLikeMathSource(source, type) {
    const trimmed = String(source || "").trim();
    if (!trimmed || /[\r\n]/.test(trimmed) && type === "inline") {
      return false;
    }
    if (/^\$\$?[\s\S]+\$\$?$/.test(trimmed) || /^\\[([][\s\S]+\\[)\]]$/.test(trimmed)) {
      return true;
    }

    let content = trimmed;
    const paired = (trimmed.startsWith("(") && trimmed.endsWith(")"))
      || (trimmed.startsWith("[") && trimmed.endsWith("]"));
    if (paired) {
      content = trimmed.slice(1, -1).trim();
      if (/^[A-Za-z]$/.test(content)) {
        return true;
      }
    }

    const hasCommand = /\\[A-Za-z]+/.test(content);
    const hasOperator = /[_^=<>+*/|{}]|(?:<=|>=|!=|:=|->)/.test(content);
    const hasUnicodeMath = /[α-ωΑ-Ω∑∏√∞≈≠≤≥∂∇∫±×÷∈∉⊂⊆∪∩→←↔]/u.test(content);
    const hasMixedVariableNumber = /(?:[A-Za-z]\d|\d[A-Za-z])/.test(content);
    if (!(hasCommand || hasOperator || hasUnicodeMath || hasMixedVariableNumber)) {
      return false;
    }

    if (type === "block" && !paired && !hasCommand) {
      const wordCount = (content.match(/[A-Za-z]{2,}/g) || []).length;
      if (wordCount > 3 && /[.!?。！？]\s*$/.test(content)) {
        return false;
      }
    }
    return true;
  }

  function isInsideProtectedContent(node) {
    for (let current = node; current && current !== node.ownerDocument?.body; current = current.parentElement) {
      if (isProtectedElement(current)) {
        return true;
      }
    }
    return false;
  }

  function isProtectedElement(node) {
    if (!node || node.nodeType !== 1) {
      return false;
    }
    if (PROTECTED_TAGS.has(node.tagName) || node.classList?.contains("math")) {
      return true;
    }
    if (node.getAttribute?.("contenteditable") === "false") {
      return true;
    }
    const protectedAttributes = [
      "data-annotation",
      "data-attachment-key",
      "data-citation",
      "data-item-key",
      "data-zotero-item",
    ];
    if (protectedAttributes.some((name) => node.hasAttribute?.(name))) {
      return true;
    }
    return ["citation", "zotero-citation", "zotero-attachment", "annotation", "highlight"]
      .some((className) => node.classList?.contains(className));
  }

  function areAdjacentSiblingBlocks(left, right) {
    if (left.node.parentNode !== right.node.parentNode) {
      return false;
    }
    let current = left.node.nextSibling;
    while (current && current !== right.node) {
      if (current.nodeType === 3 && !(current.nodeValue || "").trim()) {
        current = current.nextSibling;
        continue;
      }
      if (current.nodeType === 8) {
        current = current.nextSibling;
        continue;
      }
      return false;
    }
    return current === right.node;
  }

  function insertAfter(parent, newNode, referenceNode) {
    parent.insertBefore(newNode, referenceNode.nextSibling || null);
  }

  function countOperations(operations) {
    return operations.reduce((stats, operation) => {
      stats[operation.type]++;
      return stats;
    }, { inline: 0, block: 0 });
  }

  function copyPublicBlock(record) {
    return {
      id: record.id,
      tag: record.tag,
      text: record.text,
    };
  }

  function assertPlainObject(value, message) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw validationError("invalid_schema", message);
    }
  }

  function assertExactKeys(value, expectedKeys, message) {
    const actual = Object.keys(value).sort();
    const expected = expectedKeys.slice().sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      throw validationError("invalid_schema", message);
    }
  }

  function assertString(value, fieldName, operationIndex) {
    if (typeof value !== "string") {
      throw validationError("invalid_schema", `Operation ${operationIndex + 1} ${fieldName} must be a string.`);
    }
  }

  function validationError(code, message) {
    return new AIValidationError(code, message);
  }

  const api = {
    PROTECTED_CONTENT,
    MAX_OPERATIONS,
    AIValidationError,
    extractSafeTextBlocks,
    prepareNoteHTML,
    parseModelPayload,
    validateModelResponse,
    applyModelOperations,
    createBatches,
    mergeBatchResults,
    looksLikeMathSource,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  else {
    global.ZoteroMathPatchAICore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
