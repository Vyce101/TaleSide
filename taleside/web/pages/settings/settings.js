import { initPicker } from "../picker.js";

const element = id => document.getElementById(id);
const previewItems = [
  { id: "saved", label: "My Worlds" },
  { id: "demo", label: "Demo Worlds" },
  { id: "empty", label: "No Worlds" },
];
export function initSettings({ onPreviewChange }) {
  const gear = element("settings-button");
  const overlay = element("settings-overlay");
  const home = element("home");
  const studio = element("studio");
  const tabs = [...overlay.querySelectorAll('[role="tab"]')];
  const preview = initPicker("world-preview-mode", "world-preview-label", onPreviewChange);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  function setPreviewMode(value) {
    preview.update([{ items: previewItems }], value);
  }

  function selectTab(tab) {
    preview.close();
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      element(item.getAttribute("aria-controls")).hidden = !selected;
    }
  }

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", event => {
      const next = {
        ArrowUp: tabs[(index + tabs.length - 1) % tabs.length],
        ArrowDown: tabs[(index + 1) % tabs.length],
        Home: tabs[0], End: tabs.at(-1),
      }[event.key];
      if (!next) return;
      event.preventDefault();
      selectTab(next);
      next.focus();
    });
  }

  function open() {
    delete overlay.dataset.closing;
    overlay.hidden = false;
    overlay.inert = false;
    home.inert = studio.inert = true;
    document.body.dataset.settingsOpen = "";
    gear.setAttribute("aria-expanded", "true");
    element("app-settings-title").focus({ preventScroll: true });
  }

  function close({ immediate = false, focus = false } = {}) {
    if (overlay.hidden) return;
    if (overlay.hasAttribute("data-closing") && !immediate) return;
    preview.close();
    if (focus) gear.focus({ preventScroll: true });
    overlay.inert = true;
    home.inert = studio.inert = false;
    delete document.body.dataset.settingsOpen;
    gear.setAttribute("aria-expanded", "false");
    if (immediate || reducedMotion.matches) {
      overlay.hidden = true;
      delete overlay.dataset.closing;
    } else {
      overlay.dataset.closing = "";
    }
  }

  overlay.addEventListener("animationend", event => {
    if (event.target === overlay && event.animationName === "settings-out") close({ immediate: true });
  });
  gear.addEventListener("click", () => {
    if (gear.getAttribute("aria-expanded") === "true") close({ focus: true });
    else open();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !event.defaultPrevented && document.body.hasAttribute("data-settings-open")
        && !document.querySelector("dialog[open]")) {
      event.preventDefault();
      close({ focus: true });
    }
  });

  setPreviewMode("saved");
  return { close, setPreviewMode };
}
