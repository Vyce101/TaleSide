import { keySettings } from "./data.js";
import { element } from "./dom.js";

export function renderKeyPicker(containerId: string, selected: string[], change: (ids: string[]) => void, disabled = false) {
  const container = element(containerId);
  const wasOpen = container.querySelector("button")?.getAttribute("aria-expanded") === "true";
  const active = container.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const priorFocus = active?.dataset.keyId;
  const picker = document.createElement("div");
  picker.className = "key-picker";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.id = `${containerId}-toggle`;
  toggle.className = "key-picker-toggle";
  const menu = document.createElement("div");
  menu.className = "key-picker-menu";
  menu.id = `${containerId}-choices`;
  menu.hidden = !wasOpen || disabled || !keySettings.keys.length;
  toggle.setAttribute("aria-controls", menu.id);
  toggle.setAttribute("aria-expanded", String(!menu.hidden));
  toggle.disabled = disabled || !keySettings.keys.length;
  let ids = selected.filter(id => keySettings.keys.some(key => key.id === id));
  const label = () => {
    const name = keySettings.keys.find(key => key.id === ids[0])?.nickname;
    toggle.textContent = ids.length > 1 ? `${ids.length} keys selected`
      : name ?? (keySettings.keys.length ? "Select keys" : "No saved keys");
    toggle.dataset.tooltip = toggle.textContent;
  };
  label();
  for (const key of keySettings.keys) {
    const row = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.keyId = key.id;
    input.checked = ids.includes(key.id);
    input.addEventListener("change", () => {
      ids = input.checked ? [...ids, key.id] : ids.filter(id => id !== key.id);
      label();
      change([...ids]);
    });
    row.append(input, key.nickname);
    menu.append(row);
  }
  toggle.addEventListener("click", () => {
    if (toggle.getAttribute("aria-expanded") === "true") { close(picker); return; }
    closeKeyPickers();
    showMenu(picker, true);
    toggle.setAttribute("aria-expanded", "true");
  });
  picker.addEventListener("keydown", event => {
    if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      event.stopPropagation();
      close(picker);
      toggle.focus();
    }
  });
  picker.append(toggle, menu);
  container.replaceChildren(picker);
  if (active && !toggle.disabled) {
    const checked = menu.hidden || !priorFocus ? null : menu.querySelector<HTMLInputElement>(`[data-key-id="${priorFocus}"]`);
    (checked ?? toggle).focus({ preventScroll: true });
  }
}

function showMenu(picker: Element, visible: boolean) {
  picker.querySelector<HTMLElement>(".key-picker-menu")!.hidden = !visible;
}

function close(picker: Element) {
  picker.querySelector("button")!.setAttribute("aria-expanded", "false");
  showMenu(picker, false);
}

export function closeKeyPickers(except?: Element | null) {
  for (const picker of document.querySelectorAll('.key-picker:has(button[aria-expanded="true"])')) {
    if (picker !== except) close(picker);
  }
}

document.addEventListener("click", event => {
  if (event.target instanceof Element) closeKeyPickers(event.target.closest(".key-picker"));
});
