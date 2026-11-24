import { element } from "./dom.js";
import { animateSurface } from "./motion.js";

const taleDialog = element<HTMLDialogElement>("tale-dialog");
const taleName = element<HTMLInputElement>("tale-name");
const taleDialogForm = element<HTMLFormElement>("tale-dialog-form");
let closingDialog = false;

function closeTaleDialog(value = "cancel") {
  if (!taleDialog.open || closingDialog) return;
  closingDialog = true;
  taleDialog.toggleAttribute("data-closing", true);
  const motion = animateSurface(taleDialog, [{ opacity: 1, translate: "0 0" }, { opacity: 0, translate: "0 -6px" }]);
  const close = () => {
    taleDialog.close(value);
    taleDialog.removeAttribute("data-closing");
    motion?.cancel();
  };
  if (motion) motion.onfinish = close;
  else close();
}

type DialogOptions = { checkbox?: string; confirmLabel?: string; title: string; detail?: string; initialName?: string; nameLabel?: string; danger?: boolean };

export function previewDialog(options: DialogOptions, onConfirm: (name: string, checked: boolean) => void | Promise<void>, restoreFocus?: () => void) {
  if (taleDialog.open || closingDialog) return;
  const hasName = options.initialName !== undefined;
  const confirm = element<HTMLButtonElement>("dialog-confirm");
  element("dialog-title").textContent = options.title;
  element("dialog-detail").textContent = options.detail ?? "";
  element("dialog-name-label").textContent = options.nameLabel ?? "Name";
  element("tale-name-field").hidden = !hasName;
  taleName.disabled = !hasName;
  taleName.required = hasName;
  taleName.value = options.initialName ?? "";
  taleName.setCustomValidity("");
  confirm.textContent = options.confirmLabel ?? (options.danger ? "Delete" : "Save");
  confirm.classList.toggle("danger-button", Boolean(options.danger));
  const checkbox = element<HTMLInputElement>("dialog-choice");
  element("dialog-choice-row").hidden = !options.checkbox;
  element("dialog-choice-label").textContent = options.checkbox ?? "";
  checkbox.checked = false;
  taleDialog.returnValue = "";
  taleDialog.addEventListener("close", async () => {
    closingDialog = false;
    if (taleDialog.returnValue === "confirm") await onConfirm(taleName.value.trim(), checkbox.checked);
    restoreFocus?.();
  }, { once: true });
  taleDialog.showModal();
  const motion = animateSurface(taleDialog, [{ opacity: 0, translate: "0 -6px" }, { opacity: 1, translate: "0 0" }]);
  if (motion) motion.onfinish = () => motion.cancel();
  if (hasName) {
    taleName.focus();
    taleName.select();
  }
}

export function outside({ clientX, clientY }: MouseEvent, surface: HTMLElement) {
  const { left, right, top, bottom } = surface.getBoundingClientRect();
  return clientX < left || clientX > right || clientY < top || clientY > bottom;
}

export function initializeDialog(onBackdropClick: (event: MouseEvent) => void) {
  taleDialog.addEventListener("cancel", event => {
    event.preventDefault();
    closeTaleDialog();
  });
  taleDialog.addEventListener("click", event => {
    if (event.target !== taleDialog) return;
    if (!outside(event, taleDialog)) return;
    closeTaleDialog();
    onBackdropClick(event);
  });

  taleName.addEventListener("input", () => taleName.setCustomValidity(""));
  element("dialog-cancel").addEventListener("click", () => closeTaleDialog());
  taleDialogForm.addEventListener("submit", event => {
    event.preventDefault();
    if (!taleName.disabled && !taleName.value.trim()) {
      taleName.setCustomValidity("Enter a name.");
      taleName.reportValidity();
      return;
    }
    closeTaleDialog("confirm");
  });
}
