import { BUILTIN_PROMPTS } from "../shared/story-defaults.js";
import type { PromptBlock, PromptCounts, PromptRole } from "../shared/types.js";
import { newId } from "./data.js";
import { element } from "./dom.js";
import { escapeHtml, icon, iconButton } from "./view.js";

let lastCounts: PromptCounts | undefined;

export function refreshPromptCounts(counts: PromptCounts | undefined) {
  lastCounts = counts;
  paintCounts();
}

function paintCounts() {
  const characters = (count?: number) => count === undefined ? "— chars" : `${count.toLocaleString()} chars`;
  element("prompt-total").textContent = characters(lastCounts?.total);
  for (const row of element("prompt-list").querySelectorAll<HTMLElement>("[data-prompt]")) {
    const id = row.dataset.prompt!;
    const count = lastCounts && Object.hasOwn(lastCounts.blocks, id) ? lastCounts.blocks[id] : undefined;
    row.querySelector("small")!.textContent = characters(count);
  }
}

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
      // Replace the character count with a token count when tokenization is available.
      return `<li class="prompt-row" data-prompt="${escapeHtml(block.id)}">
        <button type="button" class="icon-button prompt-handle" aria-label="Move ${escapeHtml(name)}"
          aria-description="Drag or use the up and down arrow keys" ${disabled}>${icon("drag")}</button>
        <strong class="prompt-name">${escapeHtml(name)}</strong>
        <small class="prompt-count"></small>
        ${iconButton("edit-prompt", "rename", editable ? "Edit prompt" : "Edit role", disabled)}
        ${editable ? iconButton("delete-prompt", "delete", "Delete prompt", disabled) : "<span></span>"}
        <label class="prompt-switch"><input type="checkbox" role="switch" aria-label="Enable ${escapeHtml(name)}"
          ${block.enabled ? "checked" : ""} ${disabled}><span></span></label>
      </li>`;
    }).join("");
    paintCounts();
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
  const move = (row: HTMLElement, index: number) => {
    const from = indexOf(row);
    if (index === from || index < 0 || index >= blocks.length) return;
    const target = list.children[index];
    list.insertBefore(row, index > from ? target.nextSibling : target);
    blocks.splice(index, 0, blocks.splice(from, 1)[0]);
  };

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
  list.onkeydown = event => {
    const handle = (event.target as HTMLElement).closest<HTMLButtonElement>(".prompt-handle");
    const row = handle?.closest<HTMLElement>(".prompt-row");
    if (locked || !row || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    move(row, indexOf(row) + (event.key === "ArrowUp" ? -1 : 1));
    handle!.focus();
  };

  let drag: { id: number; row: HTMLElement; offset: number } | undefined;
  list.onpointerdown = event => {
    if (locked || event.button !== 0) return;
    const handle = (event.target as Element).closest<HTMLButtonElement>(".prompt-handle");
    const row = handle?.closest<HTMLElement>(".prompt-row");
    if (!row) return;
    drag = { id: event.pointerId, row, offset: event.clientY - row.getBoundingClientRect().top };
    row.classList.add("prompt-dragged");
    list.setPointerCapture(event.pointerId);
  };
  list.onpointermove = event => {
    if (!drag || drag.id !== event.pointerId) return;
    const { row, offset } = drag;
    const drawer = list.closest(".panel-content");
    const bounds = drawer?.getBoundingClientRect();
    if (drawer && bounds) {
      if (event.clientY < bounds.top + 30) drawer.scrollTop -= 14;
      if (event.clientY > bounds.bottom - 30) drawer.scrollTop += 14;
    }
    const center = event.clientY - offset + row.offsetHeight / 2;
    const peers = [...list.children].filter(child => child !== row);
    const index = peers.findIndex(peer => {
      const bounds = peer.getBoundingClientRect();
      return center < bounds.top + bounds.height / 2;
    });
    move(row, index < 0 ? peers.length : index);
    const top = row.getBoundingClientRect().top - Number(row.dataset.delta ?? 0);
    const delta = event.clientY - offset - top;
    row.style.translate = `0 ${delta}px`;
    row.dataset.delta = String(delta);
  };
  list.onlostpointercapture = () => {
    if (!drag) return;
    drag.row.classList.remove("prompt-dragged");
    drag.row.style.translate = "";
    delete drag.row.dataset.delta;
    drag = undefined;
  };
  paint();
}
