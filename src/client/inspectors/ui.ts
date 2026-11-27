import { icon, type Icon } from "../view.js";

export const count = new Intl.NumberFormat().format;
export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function button(text: string, action: () => void, className = "quiet-button") {
  const control = el("button", className, text);
  control.type = "button";
  control.addEventListener("click", action);
  return control;
}

export function setIconControl(control: HTMLButtonElement, label: string, glyph: Icon) {
  if (control.dataset.glyph !== glyph) {
    control.innerHTML = icon(glyph);
    control.dataset.glyph = glyph;
  }
  control.setAttribute("aria-label", label);
  control.dataset.tooltip = label;
}

export function iconControl(label: string, glyph: Icon, action: () => void) {
  const control = button("", action, "icon-button");
  setIconControl(control, label, glyph);
  return control;
}

export function backControl(label: string, action: () => void) {
  const control = iconControl(label, "back", action);
  control.classList.add("inspector-back");
  control.append(el("span", "", label));
  return control;
}

export function readerHeading(title: string, back: HTMLElement, ...actions: HTMLElement[]) {
  const cluster = el("div", "inspector-reader-title");
  cluster.append(back, el("h3", "", title));
  const header = el("div", "inspector-between inspector-heading");
  header.append(cluster, ...actions);
  return header;
}

export function copyControl(getText: () => string, target: HTMLElement, compact = false) {
  const copy = () => {
    void navigator.clipboard.writeText(getText()).then(() => {
      if (compact) setIconControl(control, "Copied", "check");
      else control.textContent = "Copied";
      window.setTimeout(() => {
        if (compact) setIconControl(control, "Copy", "duplicate");
        else control.textContent = "Copy";
      }, 1400);
    }, () => {
      const range = document.createRange();
      range.selectNodeContents(target);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
  };
  const control = compact ? iconControl("Copy", "duplicate", copy) : button("Copy", copy);
  return control;
}

export function readableRequest(raw: string) {
  type Part = { text?: string; thought?: boolean; thoughtSignature?: string };
  type Content = { role?: string; parts?: Part[] };
  try {
    const request = JSON.parse(raw) as { systemInstruction?: Content; contents?: Content[]; generationConfig?: object };
    if (!Array.isArray(request?.contents)) return raw;
    const format = (name: string, block: Content) => {
      const parts = block.parts?.map(part => [
        part.text && (part.thought ? "Thinking\n" + part.text : part.text),
        part.thoughtSignature && "Thought Signature\n" + part.thoughtSignature,
      ].filter(Boolean).join("\n\n")).filter(Boolean);
      return [name, ...(parts ?? [])].join("\n\n");
    };
    const { systemInstruction, contents, ...settings } = request;
    const sections = contents.map(block => format(block.role === "model" ? "Model" : block.role === "system" ? "System" : "User", block));
    if (systemInstruction) sections.unshift(format("System Instruction", systemInstruction));
    if (Object.keys(settings).length) sections.push("Request Settings\n\n" + JSON.stringify(settings, null, 2));
    return sections.join("\n\n──────────\n\n");
  } catch { return raw; }
}

export function choices<T extends string>(options: readonly (readonly [T, string])[], selected: T, change: (value: T) => void) {
  const group = el("div", "inspector-controls");
  for (const [value, label] of options) {
    const control = button(label, () => {
      for (const sibling of group.children) sibling.setAttribute("aria-pressed", String(sibling === control));
      change(value);
    });
    control.setAttribute("aria-pressed", String(value === selected));
    group.append(control);
  }
  return group;
}

export function select<T extends string>(label: string, options: readonly (readonly [T, string])[],
  selected: T, change: (value: T) => void) {
  const control = el("select");
  control.setAttribute("aria-label", label);
  control.replaceChildren(...options.map(([value, name]) => new Option(name, value)));
  control.value = selected;
  control.addEventListener("change", () => change(control.value as T));
  return control;
}

export function search(label: string, value: string, change: (value: string) => void) {
  const input = el("input");
  input.type = "search";
  input.placeholder = label;
  input.setAttribute("aria-label", label);
  input.value = value;
  input.addEventListener("input", () => change(input.value));
  return input;
}

export const muted = (text: string) => el("p", "inspector-muted", text);

export function notice(error: unknown, retry?: () => void) {
  const wrapper = el("div", "inspector-notice");
  wrapper.append(el("p", "inline-error", error instanceof Error ? error.message : String(error)));
  if (retry) wrapper.append(button("Retry", retry));
  return wrapper;
}

export function writeAnchors(target: HTMLElement, text: string, source?: (marker: string) => void) {
  target.replaceChildren();
  if (!source) { target.textContent = text; return; }
  let cursor = 0;
  for (const match of text.matchAll(/\bB[1-9]\d{0,8}:C[1-9]\d{0,8}\b/g)) {
    target.append(text.slice(cursor, match.index), button(match[0], () => source(match[0]), "inspector-anchor"));
    cursor = match.index + match[0].length;
  }
  target.append(text.slice(cursor));
}

export function reader(text: string, label: string, source?: (marker: string) => void) {
  const pre = el("pre", "inspector-reader");
  pre.tabIndex = 0;
  pre.setAttribute("aria-label", label);
  writeAnchors(pre, text, source);
  return pre;
}

export function setMeter(progress: HTMLProgressElement, done: number, total: number | null, label: string, status: string) {
  progress.max = Math.max(1, total ?? 1);
  progress.setAttribute("aria-label", label);
  progress.dataset.indeterminate = String(total === null && status === "Running");
  if (total === null && status === "Running") progress.removeAttribute("value");
  else progress.value = total === null ? Number(status === "Complete") : done;
}

export function replacePanel(target: HTMLElement, children: Element[], animate = true) {
  target.replaceChildren(...children);
  target.scrollTop = 0;
  if (animate && !reducedMotion.matches) target.animate(
    [{ opacity: 0.25, transform: "translateY(4px)" }, { opacity: 1, transform: "translateY(0)" }],
    { duration: 145, easing: "ease-out" });
}

export function patchList<T>(target: HTMLElement, values: T[], key: (item: T) => string,
  make: (item: T) => HTMLElement, update?: (node: HTMLElement, item: T) => void) {
  const previous = new Map([...target.children].map(node => [(node as HTMLElement).dataset.key!, node as HTMLElement]));
  let before = target.firstElementChild;
  for (const value of values) {
    const id = key(value);
    let node = previous.get(id);
    if (node) {
      previous.delete(id);
      update?.(node, value);
    } else {
      node = make(value);
      node.dataset.key = id;
      if (!reducedMotion.matches) node.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1 }], { duration: 160 });
    }
    if (node === before) before = before.nextElementSibling;
    else target.insertBefore(node, before);
  }
  for (const node of previous.values()) node.remove();
}

export function locationText(location: { book?: number; chunk?: number; pass?: number; record?: string }) {
  const { book, chunk, pass, record } = location;
  const anchor = book && chunk ? `B${book}:C${chunk}` : book ? `Book ${book}` : undefined;
  return [anchor, pass != null && pass > 0 ? `Pass ${pass}` : undefined, record].filter(Boolean).join(" · ");
}

export function heading(title: string, ...items: Element[]) {
  const row = el("div", "inspector-between inspector-heading");
  row.append(el("h3", "", title), ...items);
  return row;
}
