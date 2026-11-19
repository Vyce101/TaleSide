import { initPicker } from "../picker.js";

const element = id => document.getElementById(id);
const previewItems = [
  { id: "saved", label: "My Worlds" },
  { id: "demo", label: "Demo Worlds" },
  { id: "empty", label: "No Worlds" },
];
const keyRoute = id => `/api/provider-keys/${id}`;
const describeWorlds = worlds => `${worlds.length} ${worlds.length === 1 ? "World" : "Worlds"} (${worlds.map(world => `“${world.name}”`).join(", ")})`;

export function initSettings({ request, refresh, onPreviewChange }) {
  const gear = element("settings-button");
  const overlay = element("settings-overlay");
  const home = element("home");
  const studio = element("studio");
  const tabs = [...overlay.querySelectorAll('[role="tab"]')];
  const add = element("add-api-key");
  const list = element("key-list");
  const template = element("key-row-template");
  const preview = initPicker("world-preview-mode", "world-preview-label", onPreviewChange);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const keyDialog = element("key-dialog");
  const keyForm = element("key-form");
  const keyName = element("key-nickname");
  const secret = element("key-secret");
  const reveal = element("reveal-key");
  const save = element("save-key");
  const deleteDialog = element("delete-key-dialog");
  const deleteForm = element("delete-key-form");
  const confirmDelete = element("delete-key-confirm");
  let keys = [];
  let editing;
  let keyAction;
  let deletion;
  let deleteRequest;

  function showError(id, message = "") {
    const error = element(id);
    error.textContent = message;
    error.hidden = !message;
  }

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
    home.inert = studio.inert = element("tale-chat").inert = true;
    document.body.dataset.settingsOpen = "";
    gear.setAttribute("aria-expanded", "true");
    element("app-settings-title").focus({ preventScroll: true });
    refresh();
  }

  function close({ immediate = false, focus = false } = {}) {
    if (immediate) {
      for (const dialog of [keyDialog, deleteDialog]) {
        if (dialog.open) dialog.close();
      }
    }
    if (overlay.hidden) return;
    if (overlay.hasAttribute("data-closing") && !immediate) return;
    deleteRequest = null;
    preview.close();
    if (editing) finishRename(editing);
    if (focus) gear.focus({ preventScroll: true });
    overlay.inert = true;
    home.inert = studio.inert = element("tale-chat").inert = false;
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

  function focusRow(id, selector) {
    (list.querySelector(`[data-key-id="${id}"] ${selector}`) ?? add).focus();
  }

  function render(nextKeys) {
    keys = nextKeys;
    list.setAttribute("aria-busy", "false");
    if (editing) return;
    list.replaceChildren();
    if (!keys.length) {
      const empty = document.createElement("p");
      empty.className = "settings-glass-card key-empty";
      empty.textContent = "No API keys yet.";
      list.append(empty);
      return;
    }
    const provider = document.createElement("h3");
    provider.textContent = "Google Gemini";
    const card = document.createElement("div");
    card.className = "settings-glass-card";
    list.append(provider, card);
    for (const key of keys) {
      const row = template.content.firstElementChild.cloneNode(true);
      row.dataset.keyId = key.id;
      const name = row.querySelector(".key-nickname");
      name.textContent = key.nickname;
      const rename = row.querySelector(".rename-key");
      rename.setAttribute("aria-label", `Rename ${key.nickname}`);
      const usage = row.querySelector(".key-usage");
      usage.textContent = key.worlds.length ? `Used by ${describeWorlds(key.worlds)}` : "Unused";
      const startRename = () => editName(key, row);
      name.addEventListener("dblclick", startRename);
      rename.addEventListener("click", startRename);
      const replace = row.querySelector(".replace-key");
      replace.setAttribute("aria-label", `Replace key for ${key.nickname}`);
      replace.addEventListener("click", () => openKeyDialog({
        key, restoreFocus: () => focusRow(key.id, ".replace-key"),
      }));
      const remove = row.querySelector(".delete-key");
      remove.setAttribute("aria-label", `Delete ${key.nickname}`);
      remove.addEventListener("click", () => openDelete(key.id));
      card.append(row);
    }
  }

  function finishRename(edit, restoreFocus = false) {
    if (editing !== edit) return;
    editing = null;
    edit.listeners.abort();
    edit.form.hidden = true;
    edit.label.hidden = false;
    if (restoreFocus) edit.label.querySelector("button").focus();
  }

  function editName(key, row) {
    if (editing) return;
    showError("settings-error");
    const form = row.querySelector(".key-rename");
    const label = row.querySelector(".key-label");
    const input = form.querySelector("input");
    const edit = { form, label, listeners: new AbortController() };
    editing = edit;
    label.hidden = true;
    input.value = key.nickname;
    form.hidden = false;
    input.select();
    input.focus();

    async function submit() {
      if (editing !== edit || edit.saving) return;
      const nickname = input.value.trim();
      if (nickname === key.nickname) {
        finishRename(edit, form.contains(document.activeElement));
        return;
      }
      edit.saving = true;
      input.readOnly = true;
      showError("settings-error");
      try {
        await request(`${keyRoute(key.id)}/rename`, { method: "POST", json: { nickname } });
        const restore = form.contains(document.activeElement);
        finishRename(edit);
        await refresh();
        if (restore && !overlay.inert) focusRow(key.id, ".rename-key");
      } catch (error) {
        showError("settings-error", error.message);
        if (editing === edit && !overlay.inert && document.activeElement === document.body) input.focus();
      } finally {
        edit.saving = false;
        input.readOnly = false;
      }
    }

    const options = { signal: edit.listeners.signal };
    edit.form.addEventListener("submit", event => {
      event.preventDefault();
      submit();
    }, options);
    form.addEventListener("focusout", event => {
      if (!form.contains(event.relatedTarget)) submit();
    }, options);
    form.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (!edit.saving) finishRename(edit, true);
    }, options);
    form.querySelector(".cancel-name").addEventListener("click", () => {
      if (!edit.saving) finishRename(edit, true);
    }, options);
  }

  function maskSecret(masked) {
    secret.dataset.masked = String(masked);
    if (!CSS.supports("-webkit-text-security", "disc")) secret.type = masked ? "password" : "text";
    reveal.setAttribute("aria-label", masked ? "Show API key" : "Hide API key");
    reveal.setAttribute("aria-pressed", String(!masked));
  }

  function openKeyDialog({ key, onAdded, restoreFocus }) {
    if (keyDialog.open || deleteDialog.open) return;
    deleteRequest = null;
    keyAction = { key, onAdded, restoreFocus };
    element("key-dialog-title").textContent = key ? `Replace “${key.nickname}”` : "Add API Key";
    element("key-dialog-description").textContent = key
      ? "Anything using this key will automatically switch to the new key."
      : "Saved locally for use across TaleSide. You can rename, replace, or delete keys anytime.";
    element("key-secret-label").textContent = key ? "New API Key" : "API Key";
    element("new-key-details").hidden = Boolean(key);
    keyName.required = !key;
    const names = new Set(keys.map(item => item.nickname));
    let number = 1;
    while (names.has(`Gemini Key ${number}`)) number += 1;
    keyName.value = key ? "" : `Gemini Key ${number}`;
    save.textContent = key ? "Replace Key" : "Save Key";
    secret.value = "";
    maskSecret(true);
    showError("key-dialog-error");
    keyDialog.showModal();
    if (key) secret.focus();
    else {
      keyName.focus();
      keyName.select();
    }
  }

  reveal.addEventListener("click", () => maskSecret(secret.dataset.masked !== "true"));
  add.addEventListener("click", () => openKeyDialog({ restoreFocus: () => add.focus() }));
  element("key-dialog-cancel").addEventListener("click", () => keyDialog.close());
  keyDialog.addEventListener("close", () => {
    const action = keyAction;
    keyAction = null;
    secret.value = "";
    maskSecret(true);
    action?.restoreFocus?.();
  });
  keyForm.addEventListener("submit", async event => {
    event.preventDefault();
    const action = keyAction;
    if (!action || action.saving) return;
    action.saving = save.disabled = element("key-dialog-cancel").disabled = true;
    showError("key-dialog-error");
    try {
      const saved = await request(action.key ? `${keyRoute(action.key.id)}/replace` : "/api/provider-keys", {
        method: "POST",
        json: action.key ? { secret: secret.value } : {
          provider: "gemini", nickname: keyName.value, secret: secret.value,
        },
      });
      await refresh();
      await action.onAdded?.(saved);
      if (keyAction === action) keyDialog.close();
    } catch (error) {
      if (keyAction === action) showError("key-dialog-error", error.message);
    } finally {
      action.saving = save.disabled = element("key-dialog-cancel").disabled = false;
    }
  });

  function showDeleteImpact(impact) {
    element("delete-key-title").textContent = `Delete “${impact.key.nickname}”?`;
    const effects = [];
    if (impact.worlds.length) {
      effects.push(`This removes the key from the Embedding Key selections for ${describeWorlds(impact.worlds)}.`);
    }
    if (impact.tales_use_key) {
      effects.push("This removes the key wherever it is selected for retrieval, chat, or saved Chat Profiles.");
    }
    if (effects.length) effects.push("If a selection becomes empty, choose a key the next time you need it.");
    element("delete-key-description").textContent = effects.join(" ") || "Delete this key from TaleSide?";
    confirmDelete.disabled = impact.busy;
    showError("delete-key-error", impact.busy ? "Wait for book checks to finish and pause any Worlds using this key." : "");
  }

  async function openDelete(id) {
    if (deleteRequest || deleteDialog.open) return;
    showError("settings-error");
    const loading = request(`${keyRoute(id)}/delete-impact`);
    deleteRequest = loading;
    try {
      const impact = await loading;
      if (deleteRequest !== loading) return;
      deletion = { impact };
      showDeleteImpact(impact);
      deleteDialog.showModal();
      element("delete-key-cancel").focus();
    } catch (error) {
      if (deleteRequest === loading) showError("settings-error", error.message);
    } finally {
      if (deleteRequest === loading) deleteRequest = null;
    }
  }

  element("delete-key-cancel").addEventListener("click", () => deleteDialog.close());
  deleteDialog.addEventListener("close", () => {
    const id = deletion?.impact.key.id;
    deletion = null;
    if (id && !overlay.inert) focusRow(id, ".delete-key");
  });
  deleteForm.addEventListener("submit", async event => {
    event.preventDefault();
    const action = deletion;
    if (!action || action.saving || confirmDelete.disabled) return;
    const route = keyRoute(action.impact.key.id);
    action.saving = confirmDelete.disabled = element("delete-key-cancel").disabled = true;
    showError("delete-key-error");
    try {
      await request(`${route}/delete`, { method: "POST", json: { impact: action.impact } });
      await refresh({ worlds: true });
      if (deletion === action) deleteDialog.close();
    } catch (error) {
      if (deletion !== action) return;
      if (error.status === 409) {
        try {
          const impact = await request(`${route}/delete-impact`);
          if (deletion !== action) return;
          action.impact = impact;
          showDeleteImpact(impact);
          if (!impact.busy) showError("delete-key-error", error.message);
        } catch (refreshError) {
          if (deletion !== action) return;
          showError("settings-error", refreshError.message);
          deleteDialog.close();
          refresh();
        }
      } else {
        showError("delete-key-error", error.message);
      }
    } finally {
      action.saving = element("delete-key-cancel").disabled = false;
      confirmDelete.disabled = action.impact.busy;
    }
  });

  for (const dialog of [keyDialog, deleteDialog]) {
    const saving = () => dialog === keyDialog ? keyAction?.saving : deletion?.saving;
    dialog.addEventListener("cancel", event => { if (saving()) event.preventDefault(); });
    dialog.addEventListener("click", event => {
      if (event.target !== dialog || saving()) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right
          || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
  }

  setPreviewMode("saved");
  return {
    close, render, setPreviewMode,
    addKey: openKeyDialog,
    showError: message => showError("settings-error", message),
  };
}
