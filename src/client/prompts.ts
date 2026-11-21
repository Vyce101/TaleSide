import { BUILTIN_PROMPTS } from "../shared/story-defaults.js";
import type { PromptBlock } from "../shared/types.js";
import { element } from "./dom.js";
import { escapeHtml } from "./view.js";

export function renderPrompts(blocks: PromptBlock[], locked: boolean) {
  const list = element("prompt-list");
  const paint = () => {
    list.innerHTML = blocks.map(block => {
      const editable = block.kind === "custom";
      const name = editable ? block.name : BUILTIN_PROMPTS[block.kind];
      const disabled = locked ? "disabled" : "";
      return `<li class="prompt-row" data-prompt="${escapeHtml(block.id)}">
        <strong class="prompt-name">${escapeHtml(name)}</strong>
        <label class="prompt-switch"><input type="checkbox" role="switch" aria-label="Enable ${escapeHtml(name)}"
          ${block.enabled ? "checked" : ""} ${disabled}><span></span></label>
      </li>`;
    }).join("");
  };
  const indexOf = (row: HTMLElement) => blocks.findIndex(block => block.id === row.dataset.prompt);
  list.onchange = event => {
    const input = event.target as HTMLInputElement;
    const row = input.closest<HTMLElement>(".prompt-row");
    if (!locked && row) blocks[indexOf(row)].enabled = input.checked;
  };
  paint();
}
