import { ApiError } from "./data.js";
import { element, showError } from "./dom.js";

type ToastOptions = { key?: string; temporary?: boolean; onceUntilCleared?: boolean; success?: boolean };
const visible = new Set<string>();
const reported = new Set<string>();
const TOAST_DURATION_MS = 4000;

export function clearToast(key: string) {
  reported.delete(key);
}

export function showDrawerError(id: string, failure: unknown) {
  if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) showError(id, failure);
  else showToast(failure);
}

export function showToast(failure: unknown, options: ToastOptions = {}) {
  const text = failure instanceof Error ? failure.message
    : typeof failure === "string" ? failure : "TaleSide could not complete the request.";
  const key = options.key ?? text;
  if (visible.has(key) || reported.has(key)) return;
  visible.add(key);
  if (options.onceUntilCleared) reported.add(key);

  const notice = document.createElement("div");
  notice.setAttribute("role", options.success ? "status" : "alert");
  const card = document.createElement("div");
  card.className = "toast-card";
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-description", "Dismiss notification");
  notice.append(card);
  element("toasts").append(notice);
  card.textContent = text;

  let timer: number | undefined;
  const remove = () => {
    window.clearTimeout(timer);
    notice.remove();
    visible.delete(key);
  };
  const fade = () => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { remove(); return; }
    card.classList.add("toast-leaving");
    timer = window.setTimeout(remove, 180);
  };
  card.addEventListener("click", remove);
  card.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    remove();
  });
  if (options.temporary) {
    const keep = () => {
      window.clearTimeout(timer);
      card.classList.remove("toast-leaving");
    };
    card.addEventListener("pointerenter", keep, { once: true });
    card.addEventListener("focus", keep, { once: true });
    timer = window.setTimeout(fade, TOAST_DURATION_MS);
  }
}
