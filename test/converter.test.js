const assert = require("node:assert/strict");
const { parseHTML } = require("linkedom");

global.DOMParser = class {
  parseFromString(html) {
    return parseHTML("<html><body>" + html + "</body></html>").document;
  }
};
global.NodeFilter = {
  SHOW_TEXT: 4,
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
};

const { renderMarkdownMathInHTML } = require("../chrome/content/converter.js");

function convert(html) {
  return renderMarkdownMathInHTML(html).html;
}

{
  const result = renderMarkdownMathInHTML(
    '<div class="zotero-note znv1"><p>$$</p><p>R_{\\text{format}} = 1</p><p>$$</p></div>',
  );
  assert.equal(result.stats.block, 1);
  assert.match(result.html, /<pre class="math">\$\$R_\{\\text\{format\}\} = 1\$\$<\/pre>/);
}

{
  const result = renderMarkdownMathInHTML(
    '<div class="zotero-note znv1"><p><span style="color: rgb(51, 51, 51);">$$<br>R_{\\text{format}} = 1<br>$$</span></p></div>',
  );
  assert.equal(result.stats.block, 1);
  assert.equal(
    result.html,
    '<div class="zotero-note znv1"><pre class="math">$$R_{\\text{format}} = 1$$</pre></div>',
  );
}

{
  const result = renderMarkdownMathInHTML(
    '<div class="zotero-note znv1"><p>$$R_{\\text{format}} = 1$$</p></div>',
  );
  assert.equal(result.stats.block, 1);
  assert.equal(
    result.html,
    '<div class="zotero-note znv1"><pre class="math">$$R_{\\text{format}} = 1$$</pre></div>',
  );
}

{
  const result = renderMarkdownMathInHTML(
    '<div class="zotero-note znv1"><p><span style="color: rgb(51, 51, 51);">$$R_{\\text{format}} = 1$$</span></p></div>',
  );
  assert.equal(result.stats.block, 1);
  assert.equal(
    result.html,
    '<div class="zotero-note znv1"><pre class="math">$$R_{\\text{format}} = 1$$</pre></div>',
  );
}

{
  const result = renderMarkdownMathInHTML(
    '<div class="zotero-note znv1"><p>$$ R_{\\text{name}} = \\frac{|N_G \\cap N_P|}{|N_G \\cup N_P|} $$</p></div>',
  );
  assert.equal(result.stats.block, 1);
  assert.equal(
    result.html,
    '<div class="zotero-note znv1"><pre class="math">$$R_{\\text{name}} = \\frac{|N_G \\cap N_P|}{|N_G \\cup N_P|}$$</pre></div>',
  );
}

{
  const result = renderMarkdownMathInHTML(
    '<div class="zotero-note znv1"><p>$$R_{\\text{format}} = 1$$</p><p>普通中文</p><p>$$<br>R_{\\text{correct}} = 2<br>$$</p></div>',
  );
  assert.equal(result.stats.block, 2);
  assert.equal(
    result.html,
    '<div class="zotero-note znv1"><pre class="math">$$R_{\\text{format}} = 1$$</pre><p>普通中文</p><pre class="math">$$R_{\\text{correct}} = 2$$</pre></div>',
  );
}

{
  const result = renderMarkdownMathInHTML(
    '<div class="zotero-note znv1"><p>这是 $R_{\\text{name}}$ 的定义</p></div>',
  );
  assert.equal(result.stats.inline, 1);
  assert.equal(
    result.html,
    '<div class="zotero-note znv1"><p>这是 <span class="math">$R_{\\text{name}}$</span> 的定义</p></div>',
  );
}

{
  const result = renderMarkdownMathInHTML(
    '<div class="zotero-note znv1"><p>这是 $$R_{\\text{name}}$$ 的定义</p></div>',
  );
  assert.equal(result.stats.inline, 1);
  assert.equal(
    result.html,
    '<div class="zotero-note znv1"><p>这是 <span class="math">$R_{\\text{name}}$</span> 的定义</p></div>',
  );
}

{
  const html = '<div class="zotero-note znv1"><pre>不要转换 $R_{\\text{name}}$</pre><p>转换 $x$</p></div>';
  const result = renderMarkdownMathInHTML(html);
  assert.equal(result.stats.inline, 1);
  assert.match(result.html, /<pre>不要转换 \$R_\{\\text\{name\}\}\$<\/pre>/);
  assert.match(result.html, /<span class="math">\$x\$<\/span>/);
}

{
  const html = '<div class="zotero-note znv1"><pre>不要转换 $$R_{\\text{name}}$$</pre><p>$$x$$</p></div>';
  const result = renderMarkdownMathInHTML(html);
  assert.equal(result.stats.block, 1);
  assert.match(result.html, /<pre>不要转换 \$\$R_\{\\text\{name\}\}\$\$<\/pre>/);
  assert.match(result.html, /<pre class="math">\$\$x\$\$<\/pre>/);
}

{
  const html = '<div class="zotero-note znv1"><h1>标题</h1><ul><li>中文 $a+b$</li></ul><blockquote>引用</blockquote></div>';
  const result = renderMarkdownMathInHTML(html);
  assert.equal(result.stats.inline, 1);
  assert.match(result.html, /<h1>标题<\/h1>/);
  assert.match(result.html, /<ul><li>中文 <span class="math">\$a\+b\$<\/span><\/li><\/ul>/);
  assert.match(result.html, /<blockquote>引用<\/blockquote>/);
}

{
  const result = renderMarkdownMathInHTML(
    '<div class="zotero-note znv1"><p>[</p><p>TTC=\\frac{relative distance}{closing speed}</p><p>]</p></div>',
  );
  assert.equal(result.stats.block, 1);
  assert.equal(
    result.html,
    '<div class="zotero-note znv1"><pre class="math">$$TTC=\\frac{relative distance}{closing speed}$$</pre></div>',
  );
}

{
  const result = renderMarkdownMathInHTML(
    '<div class="zotero-note znv1"><p><span>[<br>TTCP_i=\\frac{d_i}{v_i}<br>]</span></p></div>',
  );
  assert.equal(result.stats.block, 1);
  assert.equal(
    result.html,
    '<div class="zotero-note znv1"><pre class="math">$$TTCP_i=\\frac{d_i}{v_i}$$</pre></div>',
  );
}

{
  const result = renderMarkdownMathInHTML(
    '<div class="zotero-note znv1"><p>where (d_i) is the distance for car (i), compare (TTCP_1 &lt; TTCP_2), but keep (plain text).</p></div>',
  );
  assert.equal(result.stats.inline, 3);
  assert.match(result.html, /where <span class="math">\$d_i\$<\/span> is the distance for car <span class="math">\$i\$<\/span>/);
  assert.match(result.html, /compare <span class="math">\$TTCP_1 &lt; TTCP_2\$<\/span>/);
  assert.match(result.html, /\(plain text\)/);
}

{
  const result = renderMarkdownMathInHTML(
    '<div class="zotero-note znv1"><p>Keep ordinary notes (Better Notes) and dates (2026).</p><p>[not a formula]</p></div>',
  );
  assert.equal(result.stats.block, 0);
  assert.equal(result.stats.inline, 0);
  assert.match(result.html, /\(Better Notes\)/);
  assert.match(result.html, /\[not a formula\]/);
}

console.log("converter tests passed");
