import { BUILTIN_PROMPTS } from "../shared/story-defaults.js";
import type { PromptBlock, PromptRole } from "../shared/types.js";
import { newId } from "./data.js";
import { element } from "./dom.js";
import { escapeHtml, icon, iconButton } from "./view.js";

export function renderPrompts(blocks: PromptBlock[], locked: boolean) {
  const list = element("prompt-list");
  const add = element<HTMLButtonElement>("add-prompt");
  add.innerHTML = icon("plus");
  add.disabled = locked;
  const paint = () => {
    list.innerHTML = blocks.map(block => {
      const editable = block.kind === "custom";
      const name = editable ? block.name : BUILTIN_PROMPTS[block.kind];
      const disabled = locked ? "disabled" : "";
      return `<li class="prompt-row" data-prompt="${escapeHtml(block.id)}">
        <strong class="prompt-name">${escapeHtml(name)}</strong>
        ${iconButton("edit-prompt", "rename", editable ? "Edit prompt" : "Edit role", disabled)}
        ${editable ? iconButton("delete-prompt", "delete", "Delete prompt", disabled) : "<span></span>"}
        <label class="prompt-switch"><input type="checkbox" role="switch" aria-label="Enable ${escapeHtml(name)}"
          ${block.enabled ? "checked" : ""} ${disabled}><span></span></label>
      </li>`;
    }).join("");
  };
  const dialog = element<HTMLDialogElement>("prompt-dialog");
  const name = element<HTMLInputElement>("prompt-name");
  const role = element<HTMLSelectElement>("prompt-role");
  const text = element<HTMLTextAreaElement>("prompt-text");
  const edit = (block?: PromptBlock) => {
    const builtin = block && block.kind !== "custom";
    const custom = block?.kind === "custom" ? block : undefined;
    element("prompt-dialog-title").textContent = block && block.kind !== "custom"
      ? BUILTIN_PROMPTS[block.kind] : block ? "Edit prompt" : "Add prompt";
    element("prompt-name-field").hidden = Boolean(builtin);
    element("prompt-text-field").hidden = Boolean(builtin);
    name.disabled = Boolean(builtin);
    const multiRole = role.querySelector<HTMLOptionElement>('[value="multi-role"]')!;
    multiRole.hidden = multiRole.disabled = block?.kind !== "chat_history";
    name.value = custom?.name ?? "";
    role.value = block?.role ?? (block?.kind === "chat_history" ? "multi-role" : "system");
    text.value = custom?.text ?? "";
    element<HTMLFormElement>("prompt-form").onsubmit = event => {
      event.preventDefault();
      if (builtin) {
        block.role = role.value as PromptRole | "multi-role";
      } else {
        if (!name.value.trim()) { name.setCustomValidity("Enter a prompt name."); name.reportValidity(); return; }
        const fields = { name: name.value.trim(), role: role.value as PromptRole, text: text.value };
        if (custom) Object.assign(custom, fields);
        else blocks.push({ id: newId(), kind: "custom", enabled: true, ...fields });
      }
      dialog.close();
      paint();
      (block ? [...list.querySelectorAll<HTMLElement>(".prompt-row")].find(row => row.dataset.prompt === block.id)
        ?.querySelector<HTMLButtonElement>('[data-action="edit-prompt"]') : undefined)?.focus();
    };
    dialog.showModal();
    (builtin ? role : name).focus();
  };
  const indexOf = (row: HTMLElement) => blocks.findIndex(block => block.id === row.dataset.prompt);

  element<HTMLButtonElement>("add-prompt").onclick = () => edit();
  element<HTMLButtonElement>("cancel-prompt").onclick = () => dialog.close();
  name.oninput = () => name.setCustomValidity("");
  list.onclick = event => {
    if (locked) return;
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
    const row = button?.closest<HTMLElement>(".prompt-row");
    if (!button || !row) return;
    const index = indexOf(row);
    const block = blocks[index];
    if (!block) return;
    if (button.dataset.action === "edit-prompt") edit(block);
    if (block.kind === "custom" && button.dataset.action === "delete-prompt") { blocks.splice(index, 1); paint(); }
  };
  list.onchange = event => {
    const input = event.target as HTMLInputElement;
    const row = input.closest<HTMLElement>(".prompt-row");
    if (!locked && row) blocks[indexOf(row)].enabled = input.checked;
  };
  paint();
}
