import { initPicker } from "../picker.js";
import { createWorldImport } from "./import.js";

export function initReindex({ request, refreshWorlds, canEdit }) {
  const element = id => document.getElementById(id);
  const dialog = element("reindex-dialog");
  const form = element("reindex-form");
  const model = element("reindex-model");
  const size = element("reindex-size");
  const boundary = element("reindex-boundary");
  const error = element("reindex-error");
  const submit = element("submit-reindex");
  const open = element("open-reindex");
  let world;
  let options;
  let draft;
  let busy = false;

  const operation = createWorldImport({ request });
  const keys = initPicker("reindex-keys", "reindex-keys-label", selected => {
    draft.keyIds = selected;
    showError("");
  }, { multiple: true, scrollContainer: dialog });

  function showError(text) {
    error.textContent = text;
    error.hidden = !text;
  }

  function updateKeys() {
    const provider = options.models.find(item => item.id === model.value)?.provider;
    const compatible = options.keys.filter(key => key.provider === provider);
    draft.keyIds = draft.keyIds.filter(id => compatible.some(key => key.id === id));
    keys.update([{ items: compatible.map(key => ({ id: key.id, label: key.nickname })) }], draft.keyIds, {
      disabled: busy || !compatible.length,
      placeholder: compatible.length ? "Select keys" : "Add a Gemini key in App Settings",
    });
  }

  function setBusy(value) {
    busy = value;
    model.disabled = size.disabled = boundary.disabled = submit.disabled = value;
    submit.textContent = value ? "Starting reindex…" : "Start Reindexing";
    updateKeys();
  }

  open.addEventListener("click", () => {
    if (!canEdit(world) || !options?.models.length) return;
    draft = { world, keyIds: [...world.embedding_key_ids] };
    model.replaceChildren(...options.models.map(({ id }) => new Option(id, id)));
    model.value = world.model;
    size.value = world.max_chunk_size;
    boundary.value = world.boundary_search_distance;
    showError("");
    setBusy(false);
    dialog.showModal();
  });
  model.addEventListener("change", updateKeys);
  element("cancel-reindex").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    operation.cancel();
    keys.close(false, false);
    draft = null;
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !draft) return;
    keys.close();
    if (!draft.keyIds.length) {
      showError("Choose at least one saved Google Gemini key.");
      keys.focus();
      return;
    }
    if (![size, boundary].every(field => Number.isSafeInteger(field.valueAsNumber))) {
      showError("Enter a whole number within the supported range.");
      return;
    }
    if (world?.id !== draft.world.id || world.book_revision !== draft.world.book_revision || !canEdit(world)) {
      showError("This World changed. Reopen Reindex World and try again.");
      return;
    }
    const submission = draft;
    const settings = {
      world_id: world.id,
      book_revision: world.book_revision,
      model: model.value,
      max_chunk_size: size.valueAsNumber,
      boundary_search_distance: boundary.valueAsNumber,
      key_ids: draft.keyIds,
    };
    showError("");
    setBusy(true);
    try {
      const result = await operation.save(settings, [], { reindex: true });
      if (result) {
        if (draft === submission && dialog.open) dialog.close();
        await refreshWorlds(true);
      }
    } catch (failure) {
      operation.cancel();
      if (draft === submission && dialog.open) showError(failure.message);
    } finally {
      if (draft === submission && dialog.open) setBusy(false);
    }
  });

  return {
    show(current, settings) {
      world = current;
      options = settings;
      element("reindex-setting").hidden = !current || current.id.startsWith("demo-");
      open.disabled = !canEdit(current) || !options?.models.length;
    },
    close() {
      if (dialog.open) dialog.close();
      operation.cancel();
    },
  };
}
