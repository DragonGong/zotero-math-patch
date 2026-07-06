(function (global) {
  "use strict";

  const MATH_CLASS = "math";
  const INLINE_TAGS = new Set([
    "A",
    "ABBR",
    "B",
    "BDI",
    "BDO",
    "BR",
    "CITE",
    "DATA",
    "DFN",
    "EM",
    "I",
    "KBD",
    "MARK",
    "Q",
    "RP",
    "RT",
    "RUBY",
    "S",
    "SAMP",
    "SMALL",
    "SPAN",
    "STRONG",
    "SUB",
    "SUP",
    "TIME",
    "U",
    "VAR",
    "WBR",
  ]);

  function renderMarkdownMathInHTML(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html || "", "text/html");
    doc.body.normalize();
    const stats = {
      block: 0,
      inline: 0,
      changed: false,
    };

    stats.block += convertSiblingBlockMath(doc);
    stats.block += convertSingleElementBlockMath(doc);
    stats.inline += convertInlineDoubleDollarMath(doc);
    stats.inline += convertInlineMath(doc);
    stats.inline += convertParentheticalMath(doc);
    stats.changed = stats.block > 0 || stats.inline > 0;

    return {
      html: doc.body.innerHTML,
      stats,
    };
  }

  function convertSiblingBlockMath(doc) {
    let converted = 0;
    const parents = Array.from(doc.querySelectorAll("body, div, section, article, blockquote, li"));

    for (const parent of parents) {
      if (isSkipped(parent)) {
        continue;
      }

      let children = Array.from(parent.children);
      for (let i = 0; i < children.length; i++) {
        const start = children[i];
        const delimiter = getStandaloneBlockDelimiter(start);
        if (!delimiter) {
          continue;
        }

        let endIndex = -1;
        for (let j = i + 1; j < children.length; j++) {
          if (isStandaloneClosingDelimiter(children[j], delimiter)) {
            endIndex = j;
            break;
          }
        }

        if (endIndex === -1) {
          continue;
        }

        const formulaParts = children
          .slice(i + 1, endIndex)
          .map((node) => getBlockText(node))
          .join("\n")
          .trim();

        if (!formulaParts) {
          continue;
        }

        if (!isBlockFormulaForDelimiter(formulaParts, delimiter)) {
          continue;
        }

        const pre = createBlockMath(doc, formulaParts);
        parent.insertBefore(pre, start);

        for (let j = i; j <= endIndex; j++) {
          children[j].remove();
        }

        converted++;
        children = Array.from(parent.children);
        i = -1;
      }
    }

    return converted;
  }

  function convertSingleElementBlockMath(doc) {
    let converted = 0;
    const nodes = Array.from(doc.querySelectorAll("p, div:not(.zotero-note)"));

    for (const node of nodes) {
      if (isSkipped(node) || hasSkippedDescendant(node) || hasBlockElementChild(node)) {
        continue;
      }

      const text = getBlockText(node).trim();
      const match = text.match(/^\$\$([\s\S]+)\$\$$/) || text.match(/^\[([\s\S]+)\]$/);
      if (!match) {
        continue;
      }

      const formula = match[1].trim();
      if (!formula) {
        continue;
      }

      if (text[0] === "[" && !isLikelyMathFormula(formula)) {
        continue;
      }

      node.replaceWith(createBlockMath(doc, formula));
      converted++;
    }

    return converted;
  }

  function convertInlineMath(doc) {
    let converted = 0;
    const walker = doc.createTreeWalker(
      doc.body,
      NodeFilter.SHOW_TEXT,
    );

    const textNodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeValue && node.nodeValue.indexOf("$") !== -1 && !isSkipped(node.parentElement)) {
        textNodes.push(node);
      }
    }

    for (const textNode of textNodes) {
      converted += replaceInlineMathInTextNode(doc, textNode);
    }

    return converted;
  }

  function convertInlineDoubleDollarMath(doc) {
    let converted = 0;
    const walker = doc.createTreeWalker(
      doc.body,
      NodeFilter.SHOW_TEXT,
    );

    const textNodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeValue && node.nodeValue.indexOf("$$") !== -1 && !isSkipped(node.parentElement)) {
        textNodes.push(node);
      }
    }

    for (const textNode of textNodes) {
      converted += replaceDoubleDollarMathInTextNode(doc, textNode);
    }

    return converted;
  }

  function convertParentheticalMath(doc) {
    let converted = 0;
    const walker = doc.createTreeWalker(
      doc.body,
      NodeFilter.SHOW_TEXT,
    );

    const textNodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeValue && node.nodeValue.indexOf("(") !== -1 && !isSkipped(node.parentElement)) {
        textNodes.push(node);
      }
    }

    for (const textNode of textNodes) {
      converted += replaceParentheticalMathInTextNode(doc, textNode);
    }

    return converted;
  }

  function replaceParentheticalMathInTextNode(doc, textNode) {
    const text = textNode.nodeValue;
    const matches = findParentheticalMathMatches(text);
    if (!matches.length) {
      return 0;
    }

    const fragment = doc.createDocumentFragment();
    let offset = 0;

    for (const match of matches) {
      if (match.start > offset) {
        fragment.appendChild(doc.createTextNode(text.slice(offset, match.start)));
      }

      const span = doc.createElement("span");
      span.className = MATH_CLASS;
      span.textContent = "$" + match.formula + "$";
      fragment.appendChild(span);
      offset = match.end;
    }

    if (offset < text.length) {
      fragment.appendChild(doc.createTextNode(text.slice(offset)));
    }

    textNode.replaceWith(fragment);
    return matches.length;
  }

  function findParentheticalMathMatches(text) {
    const candidates = [];
    let i = 0;

    while (i < text.length) {
      if (text[i] !== "(" || isEscaped(text, i)) {
        i++;
        continue;
      }

      let end = i + 1;
      while (end < text.length) {
        if (text[end] === "\n" || text[end] === "\r") {
          end = -1;
          break;
        }
        if (text[end] === ")" && !isEscaped(text, end)) {
          break;
        }
        end++;
      }

      if (end <= i || end >= text.length) {
        i++;
        continue;
      }

      const formula = text.slice(i + 1, end);
      const kind = getParentheticalFormulaKind(text, i, end, formula);
      if (kind) {
        candidates.push({
          start: i,
          end: end + 1,
          formula,
          kind,
        });
      }

      i = end + 1;
    }

    const hasStrongFormula = candidates.some((candidate) => candidate.kind === "strong");
    return candidates
      .filter((candidate) => candidate.kind === "strong" || hasStrongFormula)
      .map((candidate) => ({
        start: candidate.start,
        end: candidate.end,
        formula: candidate.formula,
      }));
  }

  function getParentheticalFormulaKind(text, start, end, formula) {
    if (!isInlineFormula(formula)) {
      return null;
    }
    if (/[()]/.test(formula)) {
      return null;
    }
    if (!hasParentheticalBoundary(text[start - 1]) || !hasParentheticalBoundary(text[end + 1])) {
      return null;
    }
    if (isLikelyMathFormula(formula)) {
      return "strong";
    }
    if (/^[A-Za-z]$/.test(formula)) {
      return "weak";
    }
    return null;
  }

  function replaceDoubleDollarMathInTextNode(doc, textNode) {
    const text = textNode.nodeValue;
    const matches = findDoubleDollarMathMatches(text);
    if (!matches.length) {
      return 0;
    }

    const fragment = doc.createDocumentFragment();
    let offset = 0;

    for (const match of matches) {
      if (match.start > offset) {
        fragment.appendChild(doc.createTextNode(text.slice(offset, match.start)));
      }

      const span = doc.createElement("span");
      span.className = MATH_CLASS;
      span.textContent = "$" + match.formula + "$";
      fragment.appendChild(span);
      offset = match.end;
    }

    if (offset < text.length) {
      fragment.appendChild(doc.createTextNode(text.slice(offset)));
    }

    textNode.replaceWith(fragment);
    return matches.length;
  }

  function findDoubleDollarMathMatches(text) {
    const matches = [];
    let i = 0;

    while (i < text.length) {
      if (text[i] !== "$" || text[i + 1] !== "$" || isEscaped(text, i)) {
        i++;
        continue;
      }

      let end = i + 2;
      while (end < text.length) {
        if (text[end] === "\n" || text[end] === "\r") {
          end = -1;
          break;
        }
        if (text[end] === "$" && text[end + 1] === "$" && !isEscaped(text, end)) {
          break;
        }
        end++;
      }

      if (end <= i || end >= text.length - 1) {
        i += 2;
        continue;
      }

      const formula = text.slice(i + 2, end);
      if (isInlineFormula(formula)) {
        matches.push({
          start: i,
          end: end + 2,
          formula,
        });
        i = end + 2;
      }
      else {
        i += 2;
      }
    }

    return matches;
  }

  function replaceInlineMathInTextNode(doc, textNode) {
    const text = textNode.nodeValue;
    const matches = findInlineMathMatches(text);
    if (!matches.length) {
      return 0;
    }

    const fragment = doc.createDocumentFragment();
    let offset = 0;

    for (const match of matches) {
      if (match.start > offset) {
        fragment.appendChild(doc.createTextNode(text.slice(offset, match.start)));
      }

      const span = doc.createElement("span");
      span.className = MATH_CLASS;
      span.textContent = "$" + match.formula + "$";
      fragment.appendChild(span);
      offset = match.end;
    }

    if (offset < text.length) {
      fragment.appendChild(doc.createTextNode(text.slice(offset)));
    }

    textNode.replaceWith(fragment);
    return matches.length;
  }

  function findInlineMathMatches(text) {
    const matches = [];
    let i = 0;

    while (i < text.length) {
      if (text[i] !== "$" || isEscaped(text, i) || text[i + 1] === "$") {
        i++;
        continue;
      }

      let end = i + 1;
      while (end < text.length) {
        if (text[end] === "\n" || text[end] === "\r") {
          end = -1;
          break;
        }
        if (text[end] === "$" && !isEscaped(text, end) && text[end + 1] !== "$") {
          break;
        }
        end++;
      }

      if (end <= i || end >= text.length) {
        i++;
        continue;
      }

      const formula = text.slice(i + 1, end);
      if (isInlineFormula(formula)) {
        matches.push({
          start: i,
          end: end + 1,
          formula,
        });
        i = end + 1;
      }
      else {
        i++;
      }
    }

    return matches;
  }

  function isInlineFormula(formula) {
    if (!formula || formula.trim() !== formula) {
      return false;
    }
    if (/[\r\n]/.test(formula)) {
      return false;
    }
    if (/^\d[\d.,]*(\s|$)/.test(formula)) {
      return false;
    }
    return true;
  }

  function getStandaloneBlockDelimiter(node) {
    if (!isBlockElement(node) || isSkipped(node)) {
      return null;
    }
    const text = getBlockText(node).trim();
    if (text === "$$") {
      return {
        open: "$$",
        close: "$$",
        requiresMathSyntax: false,
      };
    }
    if (text === "[") {
      return {
        open: "[",
        close: "]",
        requiresMathSyntax: true,
      };
    }
    return null;
  }

  function isStandaloneClosingDelimiter(node, delimiter) {
    if (!isBlockElement(node) || isSkipped(node)) {
      return false;
    }
    return getBlockText(node).trim() === delimiter.close;
  }

  function isBlockFormulaForDelimiter(formula, delimiter) {
    return !delimiter.requiresMathSyntax || isLikelyMathFormula(formula);
  }

  function isBlockElement(node) {
    return ["P", "DIV"].includes(node.tagName);
  }

  function hasSkippedDescendant(node) {
    return !!node.querySelector("code, pre, script, style, ." + MATH_CLASS);
  }

  function hasBlockElementChild(node) {
    return Array.from(node.children).some((child) => !INLINE_TAGS.has(child.tagName));
  }

  function getBlockText(node) {
    const parts = [];
    appendText(node, parts);
    return parts.join("");
  }

  function appendText(node, parts) {
    if (node.nodeType === 3) {
      parts.push(node.nodeValue);
      return;
    }

    if (node.tagName === "BR") {
      parts.push("\n");
      return;
    }

    for (const child of Array.from(node.childNodes || [])) {
      appendText(child, parts);
    }
  }

  function createBlockMath(doc, formula) {
    const pre = doc.createElement("pre");
    pre.className = MATH_CLASS;
    pre.textContent = "$$" + formula + "$$";
    return pre;
  }

  function isSkipped(node) {
    for (let current = node; current; current = current.parentElement) {
      if (current.classList?.contains(MATH_CLASS)) {
        return true;
      }
      if (["CODE", "PRE", "SCRIPT", "STYLE"].includes(current.tagName)) {
        return true;
      }
    }
    return false;
  }

  function isEscaped(text, index) {
    let slashCount = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
      slashCount++;
    }
    return slashCount % 2 === 1;
  }

  function isLikelyMathFormula(formula) {
    return /\\[A-Za-z]+/.test(formula)
      || /[_^]/.test(formula)
      || /[=<>*/|]/.test(formula)
      || /[{}]/.test(formula)
      || /[A-Za-z]\d|\d[A-Za-z]/.test(formula);
  }

  function hasParentheticalBoundary(char) {
    return !char || !/[A-Za-z0-9_$\\]/.test(char);
  }

  const api = {
    renderMarkdownMathInHTML,
    findInlineMathMatches,
    findDoubleDollarMathMatches,
    findParentheticalMathMatches,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  else {
    global.ZoteroMathPatchConverter = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
