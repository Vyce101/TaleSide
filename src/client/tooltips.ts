import { element } from "./dom.js";

export function initializeTooltips() {
  const tooltip = element("tooltip");
  let active: HTMLElement | null = null;
  let pending: HTMLElement | null = null;
  let hoverTimer: number | undefined;
  const hoverDelayMs = 500;

  function trigger(target: EventTarget | null) {
    return target instanceof Element ? target.closest<HTMLElement>("[data-tooltip]") : null;
  }

  function hide() {
    clearTimeout(hoverTimer);
    pending = null;
    tooltip.hidden = true;
    active = null;
  }

  function show(anchor: HTMLElement) {
    const label = anchor.dataset.tooltip;
    if (anchor === active || !label || anchor.closest("[inert]")) return;
    active = anchor;
    tooltip.textContent = label;
    tooltip.hidden = false;
    const bounds = anchor.getBoundingClientRect();
    const gap = 4;
    const edge = 8;
    const left = Math.max(edge, Math.min(bounds.left, document.documentElement.clientWidth - tooltip.offsetWidth - edge));
    const below = bounds.bottom + gap;
    const top = below + tooltip.offsetHeight <= window.innerHeight - edge
      ? below : Math.max(edge, bounds.top - tooltip.offsetHeight - gap);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  document.addEventListener("pointerover", event => {
    const anchor = trigger(event.target);
    if (event.pointerType === "touch" || !anchor || anchor === pending || anchor === active) return;
    hide();
    pending = anchor;
    hoverTimer = window.setTimeout(() => {
      pending = null;
      if (anchor.matches(":hover")) show(anchor);
    }, hoverDelayMs);
  });
  document.addEventListener("pointerout", event => {
    const anchor = trigger(event.target);
    if (anchor && (anchor === active || anchor === pending) && trigger(event.relatedTarget) !== anchor) hide();
  });
  document.addEventListener("focusin", event => {
    const anchor = trigger(event.target);
    if (anchor?.matches(":focus-visible")) { hide(); show(anchor); }
  });
  document.addEventListener("focusout", event => {
    if (trigger(event.target) === active) hide();
  });
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("scroll", hide, { capture: true, passive: true });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") hide();
  });
  window.addEventListener("resize", hide);
}
