import type { World, WorldSettings } from "../shared/types.js";
import { enterWorld, navigate, previewDialog, state, showPanel, updateWorld } from "./app.js";
import { keySettings, newId, removeWorld, request, worldRoute, worlds } from "./data.js";
import { element, showError } from "./dom.js";
import { renderKeyPicker } from "./key-picker.js";
import { avatar, worldIndexStatus, worldRows } from "./view.js";
import { editorMarkup, processing, renderBooks, renderIndex, renderWorldProgress, showBoundaryWarning, upload, type EditableBook } from "./world-form.js";

type Editor = { id: string; world?: World; books: EditableBook[]; keyIds: string[]; artwork?: File;
  pendingPortrait?: string; dirty: boolean; busy: boolean; settingsSave?: Promise<void> };

let editor: Editor | undefined;

export function restoreWorldPanel() {
  if (editor) element("panel-title").textContent = editor.world?.name ?? "New World";
  else showWorldList();
}

function showWorldList() {
  element("world-panel").innerHTML = worldRows(state.world);
  element("panel-title").textContent = "Worlds";
}

function warnOnUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = "";
}

function markDirty(form: Editor) {
  if (!form.world && !form.dirty) {
    form.dirty = true;
    window.addEventListener("beforeunload", warnOnUnload);
  }
}

function closeWorldEditor() {
  if (editor?.pendingPortrait) URL.revokeObjectURL(editor.pendingPortrait);
  window.removeEventListener("beforeunload", warnOnUnload);
  editor = undefined;
}

export function hideWorldPanel() { if (editor?.world) closeWorldEditor(); }

export function leaveWorldSetup(leave: () => void) {
  if (editor?.busy && !editor.world) return;
  if (!editor?.dirty) { leave(); return; }
  previewDialog({ title: "Discard World setup?", detail: "Your unsaved World settings and selected files will be cleared.",
    danger: true, confirmLabel: "Discard" }, () => { closeWorldEditor(); leave(); });
}

export function openWorldEditor(world?: World) {
  if (editor && editor.world?.id === world?.id) return;
  const indexingOpen = element("world-panel").querySelector<HTMLDetailsElement>(".index-settings")?.open;
  if (state.panel !== "worlds") showPanel("worlds", false);
  closeWorldEditor();
  const form: Editor = {
    id: world?.id ?? newId(), world, books: world?.books ?? [], keyIds: world?.embedding_key_ids ?? keySettings.defaults.key_ids,
    dirty: false, busy: false,
  };
  editor = form;
  element("panel-title").textContent = world?.name ?? "New World";
  element("world-panel").innerHTML = editorMarkup(world, indexingOpen);
  const model = element<HTMLSelectElement>("world-model");
  const selected = world && world.status !== "unindexed" ? world.model : keySettings.defaults.model;
  model.replaceChildren(...keySettings.models.map(item => new Option(item.id, item.id)));
  if (![...model.options].some(option => option.value === selected)) model.add(new Option(selected, selected));
  model.value = selected;

  const name = element<HTMLInputElement>("world-name-input");
  name.addEventListener("input", () => markDirty(form));
  name.addEventListener("change", async () => {
    if (!form.world || name.value.trim() === form.world.name) return;
    if (!name.value.trim()) { name.value = form.world.name; return; }
    try {
      const world = await request<World>(`${worldRoute(form.id)}/rename`, { name: name.value });
      updateWorld(world);
      if (editor === form) element("panel-title").textContent = world.name;
    } catch (error) { if (editor === form) showError("world-error", error); }
  });
  for (const id of ["world-model", "world-chunk-size", "world-boundary"]) {
    element(id).addEventListener("input", () => { markDirty(form); showBoundaryWarning(); });
    element(id).addEventListener("change", () => {
      if (form.world?.status === "unindexed") saveIndexSettings(form);
    });
  }
  element("world-index-action").addEventListener("click", () => {
    const status = form.world?.status;
    if (status === "creating") void act(form, "pause");
    if (status === "paused" || status === "failed") void act(form, "resume");
  });
  element("world-editor").addEventListener("submit", event => {
    event.preventDefault();
    void saveWorld(form);
  });
  element<HTMLInputElement>("world-art-input").addEventListener("change", event => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) void changeArtwork(form, file);
  });
  refreshEditor(form);
  updateWorldEditorKeys();
  element("panel-content").scrollTop = 0;
  (world ? element("world-list-button") : name).focus({ preventScroll: true });
}

async function changeArtwork(form: Editor, file: File) {
  if (form.world) {
    const body = new FormData();
    body.append("artwork", file);
    try {
      const result = await request<World>(`${worldRoute(form.id)}/artwork`, body);
      updateWorld(result);
      if (editor === form) element("world-editor-art").innerHTML = avatar(result);
    } catch (error) { if (editor === form) showError("world-error", error); }
    return;
  }
  if (form.pendingPortrait) URL.revokeObjectURL(form.pendingPortrait);
  form.artwork = file;
  form.pendingPortrait = URL.createObjectURL(file);
  markDirty(form);
  element("world-editor-art").innerHTML = avatar({ artwork: form.pendingPortrait });
}

function refreshEditor(form: Editor) { renderIndex(form.world, form.books, form.busy); }

export function updateWorldEditorKeys() {
  const form = editor;
  if (!form) return;
  const available = new Set(keySettings.keys.map(key => key.id));
  form.keyIds = form.keyIds.filter(id => available.has(id));
  renderKeyPicker("world-key", form.keyIds, ids => {
    form.keyIds = ids;
    markDirty(form);
    if (form.world?.status === "unindexed") saveIndexSettings(form);
    else if (form.world) {
      const picker = element("world-key");
      picker.inert = true;
      void act(form, "embedding-key", { key_ids: ids }).finally(() => { picker.inert = false; });
    }
  }, processing(form.world) || form.busy);
}

function readSettings(form: Editor): WorldSettings {
  return {
    name: element<HTMLInputElement>("world-name-input").value.trim(),
    model: element<HTMLSelectElement>("world-model").value,
    key_ids: form.keyIds,
    max_chunk_size: element<HTMLInputElement>("world-chunk-size").valueAsNumber,
    boundary_search_distance: element<HTMLInputElement>("world-boundary").valueAsNumber,
  };
}

function saveIndexSettings(form: Editor) {
  const settings = readSettings(form);
  if (!Number.isSafeInteger(settings.max_chunk_size) || settings.max_chunk_size < 1
    || !Number.isSafeInteger(settings.boundary_search_distance) || settings.boundary_search_distance < 0) return;
  form.settingsSave = (form.settingsSave ?? Promise.resolve()).then(async () => {
    if (form.world?.status !== "unindexed") return;
    try {
      updateWorld(await request<World>(`${worldRoute(form.id)}/index-settings`, { ...settings, book_revision: form.world.book_revision }));
    } catch (error) { if (editor === form) showError("world-error", error); }
  });
}

async function saveWorld(form: Editor) {
  if (form.busy || (form.world && form.world.status !== "unindexed")) return;
  const settings = readSettings(form);
  if ((form.world || form.books.length) && !settings.key_ids.length) {
    showError("world-error", "Choose at least one saved Google AI Studio key before indexing.");
    element("world-model").closest("details")!.open = true;
    return;
  }
  await form.settingsSave;
  if (editor !== form) return;
  if (form.world) {
    await act(form, "start-index", { ...settings, book_revision: form.world.book_revision });
    return;
  }
  const result = await act(form, "create", upload(settings, form.books, form.artwork));
  if (!result) return;
  closeWorldEditor();
  await enterWorld(result);
  if (state.panel === "worlds") {
    openWorldEditor(result);
    element("world-index-action").focus({ preventScroll: true });
  }
}

async function act(form: Editor, action: string, input: object = {}): Promise<World | undefined> {
  if (form.busy) return;
  form.busy = true;
  showError("world-error");
  refreshEditor(form);
  try {
    const result = await request<World>(`${worldRoute(form.id)}/${action}`, input);
    updateWorld(result);
    return result;
  } catch (error) {
    if (editor === form) {
      showError("world-error", error);
      if (form.world) {
        try { updateWorld(await request<World>(worldRoute(form.id))); } catch { /* Keep the original error. */ }
      }
    }
  } finally {
    form.busy = false;
    if (editor === form) {
      refreshEditor(form);
      updateWorldEditorKeys();
    }
  }
}

function discardWorld(world: World) {
  previewDialog({ title: "Delete World?", detail: `Permanently remove “${world.name}”, its books, and all its Tales?`, danger: true },
    async () => {
      try {
        await request(`${worldRoute(world.id)}/discard`, {});
        removeWorld(world.id);
        if (editor?.id === world.id) closeWorldEditor();
        navigate();
      } catch (error) { showError("app-error", error); }
    });
}

export function handleWorldAction(action: string | undefined, id: string | undefined, button: HTMLButtonElement) {
  if (action === "create-world") { openWorldEditor(); return; }
  if (action === "world-list") {
    leaveWorldSetup(() => {
      closeWorldEditor();
      showWorldList();
      element("world-panel").querySelector<HTMLButtonElement>('[data-action="create-world"]')?.focus();
    });
    return;
  }
  const form = editor;
  if (!form || form.busy) return;
  if (action === "discard-world" && form.world) { discardWorld(form.world); return; }
  if (action === "clear-index") {
    if (!form.world || processing(form.world)) return;
    previewDialog({ title: "Delete indexing?", detail: "Your books and Tales will be kept. To chat again, start indexing and wait for the first passage.", danger: true },
      async () => {
        await act(form, "clear-index");
        if (editor === form) element("world-index-action").focus({ preventScroll: true });
      });
    return;
  }
}
