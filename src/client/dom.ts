export function element<T extends HTMLElement = HTMLElement>(id: string) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}

export function showError(id: string, failure?: unknown) {
  const target = document.getElementById(id);
  if (!target) return;
  const message = failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "";
  target.textContent = message;
  target.hidden = !message;
}
