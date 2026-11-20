type Markdown = {
  render(text: string): string;
  renderer: { rules: { image: (tokens: { content: string }[], index: number) => string } };
  utils: { escapeHtml(text: string): string };
};
const path = "/assets/vendor/markdown-it-15.0.3.mjs";
const { default: markdownit } = await import(path) as { default: (options: { html: boolean; breaks: boolean }) => Markdown };

const thoughts = markdownit({ html: false, breaks: false });
const replies = markdownit({ html: false, breaks: true });
for (const markdown of [thoughts, replies]) {
  markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);
}

// Use an opening mark, content and its matching closing mark from the original text.
const dialogue = /"[^"\n]+"|“[^”\n]+”|«[^»\n]+»|「[^」\n]+」/gu;

export function renderMarkdown(container: Element, text: string, reply = false) {
  const template = document.createElement("template");
  template.innerHTML = (reply ? replies : thoughts).render(text);
  if (reply) tintDialogue(template.content);
  container.replaceChildren(template.content);
}

export function tintDialogue(fragment: DocumentFragment | Element) {
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  type TextEntry = { node: Text; skip: boolean };
  const groups: TextEntry[][] = [];
  let nodes: TextEntry[] | undefined;
  let block: Element | null | undefined;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
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
      text += skip ? " ".repeat(node.length) : node.data;
      return { node, skip, start, end: text.length };
    });
    const matches = [...text.matchAll(dialogue)];
    let firstMatch = 0;
    for (const { node, skip, start, end } of entries) {
      if (skip) continue;
      while (firstMatch < matches.length && matches[firstMatch].index! + matches[firstMatch][0].length <= start) {
        firstMatch++;
      }
      if (firstMatch < matches.length && matches[firstMatch].index! < end) {
        tintNode(node, start, end, matches, firstMatch);
      }
    }
  }
}

function tintNode(node: Text, start: number, end: number, matches: RegExpMatchArray[], firstMatch: number) {
  const value = node.data;
  const tinted = document.createDocumentFragment();
  let offset = 0;
  for (let index = firstMatch; index < matches.length && matches[index].index! < end; index++) {
    const match = matches[index];
    const from = Math.max(0, match.index! - start);
    const to = Math.min(value.length, match.index! + match[0].length - start);
    tinted.append(value.slice(offset, from));
    const span = document.createElement("span");
    span.className = "dialogue";
    span.textContent = value.slice(from, to);
    tinted.append(span);
    offset = to;
  }
  tinted.append(value.slice(offset));
  node.replaceWith(tinted);
}
