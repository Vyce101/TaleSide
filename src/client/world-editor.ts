import { previewDialog } from "./dialog.js";
import { FIRST_MESSAGE, WORLD_DESCRIPTION } from "../shared/story-defaults.js";
import { CHAT_MODELS } from "../shared/models.js";
import type { World, WorldSettings } from "../shared/types.js";
import { enterWorld, navigate, state, showPanel, updateWorld } from "./app.js";
import { keySettings, newId, removeWorld, request, worldRoute, worlds } from "./data.js";
import { cropArtwork } from "./artwork.js";
import { element, showError } from "./dom.js";
import { showDrawerError, showToast } from "./toasts.js";
import { renderKeyPicker } from "./key-picker.js";
import { avatar, iconButton, searchInput, worldRows } from "./view.js";
import { editorMarkup, processing, renderBooks, renderIndex, renderWorldProgress, upload, type EditableBook } from "./world-form.js";

type Editor = { description: string; openings: string[]; id: string; world?: World; books: EditableBook[]; keyIds: string[];
  extractionKeyIds: string[]; artwork?: File;
  pendingPortrait?: string; dirty: boolean; busy: boolean; settingsSave?: Promise<void> };

let editor: Editor | undefined;

export function restoreWorldPanel() {
  if (editor) element("panel-title").textContent = editor.world?.name ?? "New World";
  else if (state.world) openWorldEditor(state.world);
  else showWorldList();
}

let worldQuery = "";
let renderedWorldRows = "";

function normalizeSearch(text: string) {
  return text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function updateWorldRows() {
  const query = normalizeSearch(worldQuery);
  const words = query.split(" ");
  const entries = query ? worlds.flatMap(world => {
    const name = normalizeSearch(world.name);
    const text = [name, ...world.books.flatMap(book => [normalizeSearch(book.name), normalizeSearch(book.filename)])].join(" ");
    if (!words.every(word => text.includes(word))) return [];
    const rank = name.startsWith(query) ? 0 : words.every(word => name.includes(word)) ? 1 : 2;
    return [{ world, rank }];
  }).sort((a, b) => a.rank - b.rank).map(({ world }) => world) : worlds;
  const list = element("world-list");
  const rows = worldRows(entries, state.world, !!query);
  if (renderedWorldRows !== rows) {
    const focusedId = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.id : undefined;
    list.innerHTML = rows;
    renderedWorldRows = rows;
    if (focusedId) list.querySelector<HTMLElement>(`[data-id="${focusedId}"]`)?.focus({ preventScroll: true });
  }
}

function showWorldList() {
  renderedWorldRows = "";
  element("world-panel").innerHTML = `<div class="world-picker-tools">${searchInput("world-search", "Search Worlds")}
    ${iconButton("create-world", "plus", "New World")}</div><ul id="world-list" class="world-list"></ul>`;
  const input = element<HTMLInputElement>("world-search");
  input.value = worldQuery;
  input.addEventListener("input", () => {
    worldQuery = input.value;
    updateWorldRows();
  });
  updateWorldRows();
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
    extractionKeyIds: world?.extraction_key_ids ?? [], dirty: false, busy: false, description: world?.description ?? WORLD_DESCRIPTION, openings: [...(world?.openings ?? [FIRST_MESSAGE])],
  };
  editor = form;
  element("panel-title").textContent = world?.name ?? "New World";
  element("world-panel").innerHTML = editorMarkup(world, indexingOpen);
  bindWorldStory(form);
  const model = element<HTMLSelectElement>("world-model");
  const selected = world && world.status !== "unindexed" ? world.model : keySettings.defaults.model;
  model.replaceChildren(...keySettings.models.map(item => new Option(item.id, item.id)));
  if (![...model.options].some(option => option.value === selected)) model.add(new Option(selected, selected));
  model.value = selected;
  bindGraphSettings(form);

  const name = element<HTMLInputElement>("world-name-input");
  name.addEventListener("input", () => markDirty(form));
  name.addEventListener("change", async () => {
    if (!form.world || name.value.trim() === form.world.name) return;
    if (!name.value.trim()) { name.value = form.world.name; return; }
    try {
      const world = await request<World>(`${worldRoute(form.id)}/rename`, { name: name.value });
      updateWorld(world);
      if (editor === form) element("panel-title").textContent = world.name;
    } catch (error) { if (editor === form) showDrawerError("world-error", error); }
  });
  for (const id of ["world-model", "world-chunk-size"]) {
    element(id).addEventListener("input", () => { markDirty(form); });
    element(id).addEventListener("change", () => {
      if (form.world?.status === "unindexed") saveIndexSettings(form);
    });
  }
  element("world-index-action").addEventListener("click", () => {
    const status = form.world?.status;
    if (status === "creating") void act(form, "pause");
    if (status === "paused" || status === "failed") {
      if (form.world?.graph) void act(form, "resume");
      else void saveWorld(form);
    }
    if (status === "ready" && !form.world?.graph) void saveWorld(form);
  });
  element("world-progress").addEventListener("toggle", () => { if (editor === form) renderWorldProgress(form.world); });
  element("world-editor").addEventListener("submit", event => {
    event.preventDefault();
    void saveWorld(form);
  });
  element<HTMLInputElement>("world-art-input").addEventListener("change", async event => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    input.disabled = true;
    showError("world-error");
    try {
      const picture = await cropArtwork(file);
      if (picture && editor === form) await changeArtwork(form, picture);
    } catch (error) {
      if (editor === form) showError("world-error", error);
    } finally {
      input.disabled = false;
      if (editor === form) input.focus({ preventScroll: true });
    }
  });
  element<HTMLInputElement>("world-books-input").addEventListener("change", async event => {
    const input = event.target as HTMLInputElement;
    const incoming = [...(input.files ?? [])];
    input.value = "";
    const books = incoming.filter(file => /\.(txt|md|markdown|html?|epub)$/i.test(file.name) && file.size).map(file => ({
      id: newId(), number: 0, name: file.name.replace(/\.[^.]+$/, "").slice(0, 100), filename: file.name, file,
      total_chunks: 0, embedded_chunks: 0, extracted_chunks: 0,
    }));
    if (books.length) {
      if (form.world) await act(form, "add-books", upload({ book_revision: form.world.book_revision }, books));
      else {
        form.books.push(...books);
        markDirty(form);
        refreshEditor(form);
      }
    }
    if (editor === form && incoming.length !== books.length) {
      showError("world-error", "Choose nonempty TXT, Markdown, HTML, or EPUB files.");
    }
  });
  refreshEditor(form);
  updateWorldEditorKeys();
  element("panel-content").scrollTop = 0;
  (world ? element("world-list-button") : name).focus({ preventScroll: true });
}

function bindGraphSettings(form: Editor) {
  const model = element<HTMLSelectElement>("world-extraction-model");
  const thinking = element<HTMLSelectElement>("world-extraction-thinking");
  const overlap = element<HTMLInputElement>("world-preceding-context");
  const chunk = element<HTMLInputElement>("world-chunk-size");
  let defaultOverlap = !form.world?.graph || form.world.graph.preceding_context === Math.round(chunk.valueAsNumber / 10);
  const chooseThinking = (selected = "") => {
    const spec = CHAT_MODELS.find(item => item.id === model.value);
    const levels = spec?.thinking_levels ?? [];
    thinking.replaceChildren(new Option("Choose a thinking level", ""), ...levels.map(level =>
      new Option(level === "XHIGH" ? "Extra high" : level[0] + level.slice(1).toLowerCase(), level)));
    thinking.value = selected;
  };
  model.replaceChildren(new Option("Choose an extraction model", ""), ...CHAT_MODELS.map(item => new Option(item.label, item.id)));
  model.value = form.world?.graph?.model ?? "";
  chooseThinking(form.world?.graph?.thinking_level);
  model.addEventListener("change", () => chooseThinking());
  overlap.addEventListener("input", () => { defaultOverlap = false; });
  chunk.addEventListener("input", () => {
    if (defaultOverlap && Number.isFinite(chunk.valueAsNumber)) overlap.value = String(Math.round(chunk.valueAsNumber / 10));
  });
  for (const control of [model, thinking, overlap, element("world-gleaning-passes")]) {
    control.addEventListener("change", () => {
      markDirty(form);
      if (form.world?.status === "unindexed") saveIndexSettings(form);
    });
  }
}

function bindWorldStory(form: Editor) {
  const description = element<HTMLTextAreaElement>("world-description");
  const opening = element<HTMLTextAreaElement>("world-opening");
  const controls = element("opening-controls");
  let selected = 0;
  let pending = Promise.resolve();
  let saveTimer: number | undefined;
  description.value = form.description;
  const save = () => {
    window.clearTimeout(saveTimer);
    markDirty(form);
    if (!form.world) return;
    const body = { description: form.description, openings: [...form.openings] };
    pending = pending.then(async () => {
      try { updateWorld(await request<World>(`${worldRoute(form.id)}/story`, body)); }
      catch (error) { if (editor === form) showDrawerError("world-error", error); }
    });
  };
  const paint = () => {
    opening.value = form.openings[selected];
    controls.innerHTML = [
      iconButton("opening-back", "left", "Previous First Message", selected === 0 ? "disabled" : ""),
      `<span>${selected + 1}/${form.openings.length}</span>`,
      iconButton("opening-next", "right", "Next First Message"),
      iconButton("opening-delete", "delete", "Delete First Message"),
    ].join("");
  };
  description.addEventListener("input", () => { form.description = description.value; markDirty(form); });
  opening.addEventListener("input", () => {
    form.openings[selected] = opening.value;
    markDirty(form);
    if (!form.world) return;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(save, 250);
  });
  description.addEventListener("change", save);
  opening.addEventListener("change", save);
  controls.addEventListener("click", event => {
    const action = (event.target as Element).closest("button")?.dataset.action;
    if (action === "opening-back" && selected > 0) selected--;
    if (action === "opening-next") {
      selected++;
      if (selected === form.openings.length) { form.openings.push(""); save(); }
    }
    if (action === "opening-delete") {
      if (form.openings.length === 1) form.openings[0] = "";
      else form.openings.splice(selected, 1);
      selected = Math.min(selected, form.openings.length - 1);
      save();
    }
    paint();
    controls.querySelector<HTMLButtonElement>(`[data-action="${action}"]:enabled`)?.focus();
  });
  paint();
}

async function changeArtwork(form: Editor, file: File) {
  if (form.world) {
    const body = new FormData();
    body.append("artwork", file);
    try {
      const result = await request<World>(`${worldRoute(form.id)}/artwork`, body);
      updateWorld(result);
      if (editor === form) element("world-editor-art").innerHTML = avatar(result);
    } catch (error) { if (editor === form) showDrawerError("world-error", error); }
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
  form.extractionKeyIds = form.extractionKeyIds.filter(id => available.has(id));
  renderKeyPicker("world-extraction-key", form.extractionKeyIds, ids => {
    form.extractionKeyIds = ids;
    markDirty(form);
    if (form.world?.status === "unindexed") saveIndexSettings(form);
    else if (form.world?.graph) void act(form, "extraction-key", { key_ids: ids });
  }, processing(form.world) || form.busy);
}

function readSettings(form: Editor): WorldSettings {
  return {
    name: element<HTMLInputElement>("world-name-input").value.trim(),
    model: element<HTMLSelectElement>("world-model").value,
    key_ids: form.keyIds,
    max_chunk_size: element<HTMLInputElement>("world-chunk-size").valueAsNumber,
    graph: {
      model: element<HTMLSelectElement>("world-extraction-model").value,
      thinking_level: element<HTMLSelectElement>("world-extraction-thinking").value,
      preceding_context: element<HTMLInputElement>("world-preceding-context").valueAsNumber,
      gleaning_passes: element<HTMLInputElement>("world-gleaning-passes").valueAsNumber,
    },
    extraction_key_ids: form.extractionKeyIds,
  };
}

function checkGraphSettings(settings: WorldSettings) {
  let error = "";
  if (!settings.graph.model) error = "Choose an extraction model.";
  else if (!settings.graph.thinking_level) error = "Choose an extraction thinking level.";
  else if (!settings.extraction_key_ids.length) error = "Choose at least one extraction key.";
  if (!error) return true;
  element("world-extraction-model").closest("details")!.open = true;
  showError("world-error", error);
  return false;
}

function saveIndexSettings(form: Editor) {
  const settings = readSettings(form);
  if (!Number.isSafeInteger(settings.max_chunk_size) || settings.max_chunk_size < 1
    || ![settings.graph.preceding_context, settings.graph.gleaning_passes].every(value => Number.isSafeInteger(value) && value >= 0)) return;
  form.settingsSave = (form.settingsSave ?? Promise.resolve()).then(async () => {
    if (form.world?.status !== "unindexed") return;
    try {
      updateWorld(await request<World>(`${worldRoute(form.id)}/index-settings`, { ...settings, book_revision: form.world.book_revision }));
    } catch (error) { if (editor === form) showDrawerError("world-error", error); }
  });
}

async function saveWorld(form: Editor) {
  if (form.busy || processing(form.world) || (form.world?.graph && form.world.status !== "unindexed")) return;
  const settings = readSettings(form);
  if ((form.world || form.books.length) && !settings.key_ids.length) {
    showError("world-error", "Choose at least one saved Google AI Studio key before indexing.");
    element("world-model").closest("details")!.open = true;
    return;
  }
  if ((form.world || form.books.length) && !checkGraphSettings(settings)) return;
  await form.settingsSave;
  if (editor !== form) return;
  if (form.world) {
    await act(form, "start-index", { ...settings, book_revision: form.world.book_revision });
    return;
  }
  const result = await act(form, "create", upload({ ...settings, description: form.description, openings: form.openings }, form.books, form.artwork));
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
      showDrawerError("world-error", error);
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

export function isWorldEditorOpen(id: string) { return state.panel === "worlds" && editor?.world?.id === id; }

export function syncWorldPanel() {
  if (editor?.world) {
    const world = worlds.find(item => item.id === editor?.id);
    if (!world) return;
    const previous = editor.world;
    editor.world = world;
    editor.books = world.books;
    if (previous === world) return;
    if (world.status === "unindexed" && previous.status !== "unindexed") {
      element<HTMLSelectElement>("world-model").replaceChildren(...keySettings.models.map(model => new Option(model.id, model.id)));
    }
    if (JSON.stringify(previous.embedding_key_ids) !== JSON.stringify(world.embedding_key_ids)
      || JSON.stringify(previous.extraction_key_ids) !== JSON.stringify(world.extraction_key_ids) || processing(previous) !== processing(world)) {
      editor.keyIds = world.embedding_key_ids;
      if (world.graph) editor.extractionKeyIds = world.extraction_key_ids;
      if (!editor.busy) updateWorldEditorKeys();
    }
    if (previous.status !== world.status || previous.error !== world.error || previous.progress !== world.progress || previous.active_book !== world.active_book
      || previous.book_revision !== world.book_revision || JSON.stringify(previous.graph_progress) !== JSON.stringify(world.graph_progress)
      || previous.books.some((book, index) => book.extracted_chunks !== world.books[index]?.extracted_chunks)) {
      refreshEditor(editor);
    }
  } else if (!editor && state.panel === "worlds") {
    if (document.getElementById("world-list")) updateWorldRows();
    else showWorldList();
  }
}

async function moveBook(form: Editor, from: number, to: number) {
  if (from === to || !form.books[from] || !form.books[to] || form.busy || processing(form.world)) return;
  const reordered = [...form.books];
  const [book] = reordered.splice(from, 1);
  reordered.splice(to, 0, book);
  if (form.world) {
    await act(form, "book-order", { book_revision: form.world.book_revision, book_ids: reordered.map(item => item.id) });
  } else {
    form.books = reordered;
    markDirty(form);
    refreshEditor(form);
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
      } catch (error) { showToast(error); }
    });
}

export function handleWorldAction(action: string | undefined, id: string | undefined, button: HTMLButtonElement) {
  if (action === "create-world") { openWorldEditor(); return; }
  if (action === "world-list") {
    leaveWorldSetup(() => {
      closeWorldEditor();
      showWorldList();
      element("world-search").focus();
    });
    return;
  }
  const form = editor;
  if (!form || form.busy) return;
  if (action === "discard-world" && form.world) { discardWorld(form.world); return; }
  if (action === "add-world-books") { element("world-books-input").click(); return; }
  if (action === "clear-index") {
    if (!form.world || processing(form.world)) return;
    previewDialog({ title: "Delete indexing?", detail: "Your books and Tales will be kept. To chat again, start indexing and wait for the first passage.", danger: true },
      async () => {
        await act(form, "clear-index");
        if (editor === form) element("world-index-action").focus({ preventScroll: true });
      });
    return;
  }
  const index = form.books.findIndex(book => book.id === id);
  const book = form.books[index];
  if (!book || processing(form.world)) return;
  if (action === "book-up" || action === "book-down") {
    const target = index + (action === "book-up" ? -1 : 1);
    void moveBook(form, index, target).then(() => {
      if (editor === form) element("world-books").querySelector<HTMLButtonElement>(`[data-book-id="${book.id}"] [data-action="${action}"]:enabled`)?.focus();
    });
  }
  if (action === "rename-book") {
    previewDialog({ title: "Rename book", initialName: book.name }, async name => {
      if (form.world) await act(form, "rename-book", { book_revision: form.world.book_revision, book_id: book.id, name });
      else {
        book.name = name;
        markDirty(form);
        renderBooks(form.books, form.world);
      }
    });
  }
  if (action === "remove-book") {
    previewDialog({ title: "Remove book?", detail: `Remove “${book.name}” from this World?`, danger: true }, async () => {
      if (form.world) await act(form, "remove-book", { book_revision: form.world.book_revision, book_id: book.id });
      else {
        form.books.splice(index, 1);
        markDirty(form);
        refreshEditor(form);
      }
    }, () => { if (button.isConnected) button.focus(); });
  }
}
