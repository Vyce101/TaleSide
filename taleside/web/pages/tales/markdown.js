import markdownit from "/assets/vendor/markdown-it-15.0.3.mjs";

const markdown = markdownit({ html: false });
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);

// Use an opening mark, content and its matching closing mark from the original text.
const dialogue = /"[^"\n]+"|“[^”\n]+”|«[^»\n]+»|「[^」\n]+」/gu;

export function renderReply(container, text) {
  const template = document.createElement("template");
  template.innerHTML = markdown.render(text);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const groups = [];
  let nodes;
  let block;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    const nextBlock = parent?.closest("p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th");
    if (!nodes || block !== nextBlock) {
      nodes = [];
      groups.push(nodes);
      block = nextBlock;
    }
    nodes.push({ node, skip: Boolean(parent?.closest("pre, code, a")) });
  }
  for (const group of groups) {
    let text = "";
    const entries = group.map(({ node, skip }) => {
      const start = text.length;
      text += skip ? " ".repeat(node.length) : node.textContent;
      return { node, skip, start, end: text.length };
    });
    const matches = [...text.matchAll(dialogue)];
    let firstMatch = 0;
    for (const { node, skip, start, end } of entries) {
      if (skip) continue;
      while (firstMatch < matches.length && matches[firstMatch].index + matches[firstMatch][0].length <= start) {
        firstMatch++;
      }
      if (firstMatch < matches.length && matches[firstMatch].index < end) {
        tintNode(node, start, end, matches, firstMatch);
      }
    }
  }
  container.replaceChildren(template.content);
}

function tintNode(node, start, end, matches, firstMatch) {
  const value = node.textContent;
  const tinted = document.createDocumentFragment();
  let offset = 0;
  for (let index = firstMatch; index < matches.length && matches[index].index < end; index++) {
    const match = matches[index];
    const from = Math.max(0, match.index - start);
    const to = Math.min(value.length, match.index + match[0].length - start);
    tinted.append(value.slice(offset, from));
    const span = document.createElement("span");
    span.className = "tale-dialogue";
    span.textContent = value.slice(from, to);
    tinted.append(span);
    offset = to;
  }
  tinted.append(value.slice(offset));
  node.replaceWith(tinted);
}
