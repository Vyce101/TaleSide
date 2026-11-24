import type { Persona, PersonasView, Tale, World } from "../shared/types.js";
import { previewDialog } from "./dialog.js";
import { cropArtwork } from "./artwork.js";
import { request, taleRoute, type OpenTale } from "./data.js";
import { element, showError } from "./dom.js";
import { avatar, escapeHtml, icon, iconButton } from "./view.js";

type PersonaPanelOptions = {
  currentWorld: () => World | undefined;
  currentTale: () => OpenTale | undefined;
  isOpen: () => boolean;
};

export function createPersonaPanel({ currentWorld, currentTale, isOpen }: PersonaPanelOptions) {
  let view: PersonasView | undefined;
  let selected = "user";
  let revision = 0;
  const saves = new Map<string, Promise<void>>();

  function currentPersona() {
    const active = currentTale()?.persona_id ?? view?.world ?? view?.global ?? "user";
    return view?.personas.find(persona => persona.id === active) ?? view?.personas[0];
  }

  async function refreshPersonas() {
    const version = ++revision;
    const world = currentWorld()?.id;
    try {
      const updated = await request<PersonasView>("/api/personas" + (world ? `?world=${world}` : ""));
      if (version !== revision) return;
      view = updated;
      selected = (currentTale() ? currentPersona()?.id : selected) ?? "user";
      if (isOpen()) renderPanel();
    } catch (error) {
      if (version === revision && isOpen()) showError("persona-error", error);
    }
  }

  function renderList() {
    const personas = [...view!.personas].sort((left, right) => left.id === "user" ? -1 : right.id === "user" ? 1 :
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    const active = currentTale() ? currentPersona()?.id : selected;
    const list = element("persona-list");
    list.innerHTML = personas.map(persona => `<li class="persona-card" ${active === persona.id ? "data-active" : ""}>
      <button type="button" class="persona-select" data-persona="${persona.id}" aria-pressed="${selected === persona.id}">
        ${avatar(persona)}
        <span class="persona-summary">
          <span class="persona-heading">
            <strong>${escapeHtml(persona.name)}</strong><small>${escapeHtml(persona.nickname)}</small>
          </span>
          <span class="persona-preview">${persona.description.trim() ? escapeHtml(persona.description) : "No description"}</span>
        </span>
        ${view!.global === persona.id ? `<span title="Global default">${icon("star")}</span>` : ""}
        ${view!.world === persona.id ? `<span title="World default">${icon("globe")}</span>` : ""}
      </button>
      ${persona.id === "user" ? "" : iconButton("delete-persona", "delete", "Delete Persona", `data-persona="${persona.id}"`)}
    </li>`).join("");
  }

  function showPersona(persona: Persona) {
    const editor = element("persona-editor");
    const locked = persona.id === "user";
    const disabled = locked ? "disabled" : "";
    editor.innerHTML = `<div class="persona-fields">
      <label class="world-art-picker" for="persona-picture">${avatar(persona)}</label>
      <input id="persona-picture" type="file" class="offscreen-input" accept="image/*" aria-label="Change Persona picture" ${disabled}>
      <div>
        <label for="persona-name">Name <small id="persona-name-error" class="inline-error" role="alert"></small></label>
        <input id="persona-name" maxlength="100" ${disabled}>
        <label for="persona-nickname">Nickname <small id="persona-nickname-error" class="inline-error" role="alert"></small></label>
        <input id="persona-nickname" ${disabled}>
      </div>
    </div>
    <label for="persona-description">Description <small id="persona-description-error" class="inline-error" role="alert"></small></label>
    <textarea id="persona-description" rows="6" ${disabled}
      placeholder="Describe your character (appearance, personality, background, or abilities). What you type here is sent to the AI."></textarea>
    <fieldset class="persona-defaults">
      <legend>Defaults</legend>
      <button type="button" class="quiet-button" id="persona-global" ${disabled}>${icon("star")} Global Default</button>
      <button type="button" class="quiet-button" id="persona-world" ${locked || !currentWorld() ? "disabled" : ""}>${icon("globe")} World Default</button>
    </fieldset>`;
    for (const field of ["name", "nickname", "description"] as const) {
      const input = element<HTMLInputElement | HTMLTextAreaElement>(`persona-${field}`);
      input.value = persona[field];
      let timer: number | undefined;
      let last = input.value;
      const save = () => {
        window.clearTimeout(timer);
        if (input.value === last) return;
        const value = input.value;
        last = value;
        const key = persona.id + field;
        const pending = (saves.get(key) ?? Promise.resolve()).then(async () => {
          try {
            const updated = await request<Persona>("/api/personas/save", { id: persona.id, field, value });
            const card = view?.personas.find(row => row.id === updated.id);
            if (card) card[field] = updated[field];
            if (input.isConnected) element(`persona-${field}-error`).textContent = "";
            if (isOpen()) renderList();
          } catch (error) {
            if (input.isConnected && input.value === value) {
              last = persona[field];
              element(`persona-${field}-error`).textContent = error instanceof Error ? error.message : String(error);
            }
          }
        });
        saves.set(key, pending);
        void pending.finally(() => { if (saves.get(key) === pending) saves.delete(key); });
      };
      input.addEventListener("input", () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(save, 220);
      });
      input.addEventListener("blur", save);
    }

    for (const scope of ["global", "world"] as const) {
      const button = element<HTMLButtonElement>(`persona-${scope}`);
      button.setAttribute("aria-pressed", String(view![scope] === persona.id));
      button.addEventListener("click", async () => {
        const enabled = view![scope] !== persona.id;
        button.disabled = true;
        try {
          await request("/api/personas/default", { id: persona.id, world: scope === "global" ? null : currentWorld()?.id, enabled });
          view![scope] = enabled ? persona.id : null;
          button.setAttribute("aria-pressed", String(enabled));
          renderList();
        } catch (error) { showError("persona-error", error); }
        finally { button.disabled = false; }
      });
    }

    const picture = element<HTMLInputElement>("persona-picture");
    picture.addEventListener("change", async () => {
      const file = picture.files?.[0];
      picture.value = "";
      if (!file) return;
      try {
        const cropped = await cropArtwork(file, "Persona");
        if (!cropped) return;
        const body = new FormData();
        body.append("artwork", cropped);
        const updated = await request<Persona>(`/api/personas/${persona.id}/artwork`, body);
        persona.artwork = updated.artwork;
        if (picture.isConnected) picture.previousElementSibling!.innerHTML = avatar(persona);
        renderList();
      } catch (error) { showError("persona-error", error); }
    });
  }

  async function selectPersona(persona: Persona) {
    const tale = currentTale();
    if (tale) {
      if (tale.draft) tale.persona_id = persona.id;
      else {
        const saved = await request<Tale>(`${taleRoute(tale)}/persona`, { persona_id: persona.id });
        tale.persona_id = saved.persona_id;
      }
    }
    selected = persona.id;
    renderList();
    showPersona(persona);
  }

  function renderPanel() {
    if (!view) return;
    element("persona-tools").innerHTML = iconButton("create-persona", "plus", "New Persona");
    renderList();
    showPersona(view.personas.find(persona => persona.id === selected) ?? view.personas[0]);
  }

  element("persona-panel").addEventListener("click", async event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button");
    if (!button || !view) return;
    showError("persona-error");
    try {
      if (button.dataset.action === "create-persona") {
        const persona = await request<Persona>("/api/personas/create", {});
        view.personas.push(persona);
        await selectPersona(persona);
        element("persona-name").focus();
        return;
      }
      const persona = view.personas.find(item => item.id === button.dataset.persona);
      if (!persona) return;
      if (button.dataset.action === "delete-persona") {
        previewDialog({ title: "Delete Persona?", detail: `Remove “${persona.name}” and its default assignments?`, danger: true }, async () => {
          try {
            await request("/api/personas/delete", { id: persona.id });
            const tale = currentTale();
            if (tale?.persona_id === persona.id) tale.persona_id = null;
            await refreshPersonas();
          } catch (error) { showError("persona-error", error); }
        });
      } else await selectPersona(persona);
    } catch (error) { showError("persona-error", error); }
  });

  return { currentPersona, refreshPersonas };
}
