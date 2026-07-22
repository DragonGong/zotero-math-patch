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
  const UNAMBIGUOUS_MARKUP_TAGS = new Set([
    "abbr", "address", "article", "aside", "audio", "base", "blockquote", "body", "br",
    "button", "canvas", "caption", "circle", "code", "col", "data", "datalist", "dd",
    "defs", "details", "dialog", "div", "dl", "dt", "ellipse", "embed", "fieldset",
    "figcaption", "figure", "footer", "foreignobject", "form", "head", "header", "hgroup",
    "html", "iframe", "image", "img", "input", "label", "legend", "li", "line", "link",
    "main", "map", "mark", "math", "menu", "meta", "meter", "mi", "mn", "mo", "mrow",
    "nav", "noscript", "object", "ol", "optgroup", "option", "output", "path", "picture",
    "polygon", "polyline", "pre", "progress", "rect", "script", "section", "select", "slot",
    "small", "source", "span", "strong", "style", "sub", "summary", "sup", "svg", "table",
    "tbody", "td", "template", "text", "textarea", "tfoot", "th", "thead", "time", "title",
    "tr", "track", "ul", "video",
  ]);

  class AIValidationError extends Error {
    constructor(code, message, options = {}) {
      super(message);
      this.name = "AIValidationError";
      this.code = code;
      this.operationIndex = Number.isInteger(options.operationIndex)
        ? options.operationIndex
        : null;
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
      try {
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
      }
      catch (error) {
        if (error instanceof AIValidationError && !Number.isInteger(error.operationIndex)) {
          error.operationIndex = operationIndex;
        }
        throw error;
      }
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

  function applyOperationRepair(payload, repairPayload, context, options = {}) {
    const parsed = parseModelPayload(payload);
    assertPlainObject(parsed, "The candidate model response must be a JSON object.");
    if (!Array.isArray(parsed.operations)) {
      throw validationError("invalid_schema", "The candidate response operations field must be an array.");
    }

    const repair = parseModelPayload(repairPayload);
    assertPlainObject(repair, "The model repair response must be a JSON object.");
    assertExactKeys(
      repair,
      ["operationIndex", "replacement"],
      "The model repair response contains unsupported fields.",
    );
    const expectedIndex = options.operationIndex;
    if (
      !Number.isInteger(expectedIndex)
      || expectedIndex < 0
      || expectedIndex >= parsed.operations.length
      || repair.operationIndex !== expectedIndex + 1
    ) {
      throw validationError(
        "invalid_repair",
        "The model repair response does not target the requested operation.",
        expectedIndex,
      );
    }
    assertPlainObject(repair.replacement, "The model repair replacement must be an object.");

    const allowedBlockIDs = options.allowedBlockIds
      ? new Set(options.allowedBlockIds)
      : null;
    let replacement;
    try {
      if (repair.replacement.type === "inline") {
        const validation = validateModelResponse(
          { operations: [repair.replacement] },
          context,
          { allowedBlockIds: options.allowedBlockIds },
        );
        replacement = validation.operations[0];
      }
      else if (repair.replacement.type === "block") {
        assertExactKeys(
          repair.replacement,
          ["type", "blockIds", "latex"],
          "A repaired block operation must contain only type, blockIds, and latex.",
        );
        validateBlockIDs(repair.replacement.blockIds, expectedIndex);
        const records = getSafeBlockRecords(
          repair.replacement.blockIds,
          context,
          allowedBlockIDs,
          expectedIndex,
        );
        replacement = {
          type: "block",
          blockIds: records.map((record) => record.id),
          source: records.map((record) => record.text).join("\n"),
          latex: validateLatex(repair.replacement.latex, expectedIndex),
        };
      }
      else {
        throw validationError(
          "invalid_repair",
          "The repaired operation has an invalid type.",
          expectedIndex,
        );
      }
    }
    catch (error) {
      if (error instanceof AIValidationError) {
        error.operationIndex = expectedIndex;
      }
      throw error;
    }

    const operations = parsed.operations.slice();
    operations[expectedIndex] = replacement;
    return { operations };
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

    let record = getRecord(context, operation.blockId, allowedBlockIDs, operationIndex);
    let range = findOccurrenceRange(record.text, operation.source, operation.occurrence);
    if (!range) {
      const relocated = findUniqueEditableInlineTarget(context, operation.source, allowedBlockIDs);
      if (!relocated) {
        throw validationError(
          "source_mismatch",
          `Operation ${operationIndex + 1} source, blockId, and occurrence do not identify one unique editable location in the request batch.`,
        );
      }
      record = relocated.record;
      range = relocated.range;
    }
    if (!rangeIsEditable(record, range.start, range.end)) {
      throw validationError("protected_content", `Operation ${operationIndex + 1} crosses protected or non-text content.`);
    }

    return {
      operation: {
        type: "inline",
        blockId: record.id,
        source: operation.source,
        occurrence: range.occurrence,
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
    validateBlockIDs(operation.blockIds, operationIndex);
    assertString(operation.source, "source", operationIndex);
    const latex = validateLatex(operation.latex, operationIndex);
    if (!operation.source || operation.source.length > MAX_SOURCE_LENGTH) {
      throw validationError("invalid_source", `Operation ${operationIndex + 1} has an empty or oversized source.`);
    }
    if (operation.source.includes(PROTECTED_CONTENT)) {
      throw validationError("protected_content", `Operation ${operationIndex + 1} targets protected note content.`);
    }

    const records = getSafeBlockRecords(
      operation.blockIds,
      context,
      allowedBlockIDs,
      operationIndex,
    );
    const exactSource = records.map((record) => record.text).join("\n");
    if (operation.source !== exactSource) {
      throw validationError(
        "source_mismatch",
        `Operation ${operationIndex + 1} source does not exactly match its blocks.`,
      );
    }

    return {
      operation: {
        type: "block",
        blockIds: records.map((record) => record.id),
        source: exactSource,
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
    const ranges = findOccurrenceRanges(text, source);
    if (occurrence <= ranges.length) {
      return ranges[occurrence - 1];
    }
    if (ranges.length === 1) {
      return ranges[0];
    }
    return null;
  }

  function findOccurrenceRanges(text, source) {
    const ranges = [];
    let offset = 0;
    while (offset <= text.length - source.length) {
      const found = text.indexOf(source, offset);
      if (found === -1) {
        break;
      }
      ranges.push({
        start: found,
        end: found + source.length,
        occurrence: ranges.length + 1,
      });
      offset = found + source.length;
    }
    return ranges;
  }

  function findUniqueEditableInlineTarget(context, source, allowedBlockIDs) {
    const candidates = [];
    for (const record of context?.records || []) {
      if (allowedBlockIDs && !allowedBlockIDs.has(record.id)) {
        continue;
      }
      for (const range of findOccurrenceRanges(record.text, source)) {
        if (rangeIsEditable(record, range.start, range.end)) {
          candidates.push({ record, range });
        }
      }
    }
    return candidates.length === 1 ? candidates[0] : null;
  }

  function areContiguousBlockRecords(records) {
    for (let index = 1; index < records.length; index++) {
      if (
        records[index].index !== records[index - 1].index + 1
        || !areAdjacentSiblingBlocks(records[index - 1], records[index])
      ) {
        return false;
      }
    }
    return true;
  }

  function validateBlockIDs(blockIDs, operationIndex) {
    if (!Array.isArray(blockIDs) || !blockIDs.length) {
      throw validationError("invalid_block_ids", `Operation ${operationIndex + 1} blockIds must be a non-empty array.`);
    }
    if (blockIDs.some((id) => typeof id !== "string")) {
      throw validationError("invalid_block_ids", `Operation ${operationIndex + 1} blockIds must contain strings only.`);
    }
    if (new Set(blockIDs).size !== blockIDs.length) {
      throw validationError("invalid_block_ids", `Operation ${operationIndex + 1} repeats a blockId.`);
    }
  }

  function getSafeBlockRecords(blockIDs, context, allowedBlockIDs, operationIndex) {
    const records = blockIDs.map(
      (id) => getRecord(context, id, allowedBlockIDs, operationIndex),
    );
    for (const record of records) {
      if (!record.allowBlockReplacement || record.text.includes(PROTECTED_CONTENT)) {
        throw validationError("protected_content", `Operation ${operationIndex + 1} cannot replace this block safely.`);
      }
    }
    if (!areContiguousBlockRecords(records)) {
      throw validationError(
        "non_contiguous_blocks",
        `Operation ${operationIndex + 1} blockIds are not contiguous sibling blocks.`,
      );
    }
    return records;
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
    if (normalized.includes("$") || containsHTMLMarkup(normalized)) {
      throw validationError("unsafe_latex", `Operation ${operationIndex + 1} latex contains delimiters or HTML.`);
    }
    if (/\\(?:htmlClass|htmlId|htmlStyle|href|url|includegraphics)\b/i.test(normalized)) {
      throw validationError("unsafe_latex", `Operation ${operationIndex + 1} latex contains a disallowed command.`);
    }
    if (!hasBalancedLatexBraces(normalized)) {
      throw validationError("invalid_latex", `Operation ${operationIndex + 1} latex contains unbalanced braces.`);
    }
    return normalized;
  }

  function containsHTMLMarkup(latex) {
    if (/<!--|-->|<!\s*doctype\b|<!\[CDATA\[|<\?xml\b/i.test(latex)) {
      return true;
    }

    const tagPattern = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)([^<>]*)>/g;
    let match;
    while ((match = tagPattern.exec(latex))) {
      const closing = !!match[1];
      const tagName = match[2].toLowerCase();
      const remainder = match[3];
      if (!isValidHTMLTagRemainder(remainder)) {
        continue;
      }
      const trimmedRemainder = remainder.trim();
      const selfClosing = trimmedRemainder.endsWith("/");
      const hasAttributes = trimmedRemainder.replace(/\/$/, "").trim().length > 0;
      if (closing || selfClosing || hasAttributes || tagName.includes("-")
        || UNAMBIGUOUS_MARKUP_TAGS.has(tagName)) {
        return true;
      }
    }
    return false;
  }

  function isValidHTMLTagRemainder(remainder) {
    if (!remainder) {
      return true;
    }
    return /^(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?\s*$/.test(remainder);
  }

  function hasBalancedLatexBraces(latex) {
    let depth = 0;
    let inComment = false;
    for (let index = 0; index < latex.length; index++) {
      const character = latex[index];
      if (character === "\n" || character === "\r") {
        inComment = false;
        continue;
      }
      if (inComment) {
        continue;
      }
      if (character === "%" && !isEscaped(latex, index)) {
        inComment = true;
        continue;
      }
      if ((character !== "{" && character !== "}") || isEscaped(latex, index)) {
        continue;
      }
      if (character === "{") {
        depth++;
      }
      else if (depth === 0) {
        return false;
      }
      else {
        depth--;
      }
    }
    return depth === 0;
  }

  function isEscaped(text, index) {
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
      backslashes++;
    }
    return backslashes % 2 === 1;
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

  function validationError(code, message, operationIndex = null) {
    return new AIValidationError(code, message, { operationIndex });
  }

  const api = {
    PROTECTED_CONTENT,
    MAX_OPERATIONS,
    AIValidationError,
    extractSafeTextBlocks,
    prepareNoteHTML,
    parseModelPayload,
    validateModelResponse,
    applyOperationRepair,
    applyModelOperations,
    createBatches,
    mergeBatchResults,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  else {
    global.ZoteroMathPatchAICore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
