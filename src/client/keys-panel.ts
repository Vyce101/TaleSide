import type { KeyImpact, KeySummary } from "../shared/types.js";
import { keySettings, loadKeys, loadWorlds, request } from "./data.js";
import { previewDialog } from "./dialog.js";
import { element, showError } from "./dom.js";
import { setSurfaceVisible, slideFrames } from "./motion.js";
import { showDrawerError, showToast } from "./toasts.js";
import { escapeHtml, icon, type Icon } from "./view.js";

type KeysPanelOptions = {
  isOpen: () => boolean;
  onKeysChanged: () => void;
  onWorldsReloaded: () => void;
};

export function createKeysPanel({ isOpen, onKeysChanged, onWorldsReloaded }: KeysPanelOptions) {
  let keyEditor: { action: "add" | "rename" | "replace"; key?: KeySummary } | undefined;
  let showKeyUse = false;
  let keysPending = false;

  function renderKeysView() {
    element("view-keys").setAttribute("aria-pressed", String(!showKeyUse));
    element("view-key-worlds").setAttribute("aria-pressed", String(showKeyUse));
    element("key-use").hidden = !showKeyUse;
    element("key-list").hidden = showKeyUse;
    element("add-key").hidden = showKeyUse || Boolean(keyEditor);
    const form = element("key-form");
    setSurfaceVisible(form, !showKeyUse && Boolean(keyEditor), slideFrames);
    const used = keySettings.keys.filter(key => key.worlds.length);
    element("key-use").innerHTML = used.length ? used.map(key => `<li><div class="key-identity">
      <strong>${escapeHtml(key.nickname)}</strong><small>${key.worlds.map(world => escapeHtml(world.name)).join(", ")}</small>
    </div></li>`).join("") : '<li class="empty-copy">No Worlds use a Google AI Studio key.</li>';
    element("key-list").innerHTML = keySettings.keys.map(key => `<li>
      <div class="key-identity"><strong>${escapeHtml(key.nickname)}</strong><code>•••• ${escapeHtml(key.suffix ?? "")}</code></div>
      <div class="tale-row-actions">
        ${["rename", "replace", "delete"].map(action => {
          const label = `${action[0].toUpperCase()}${action.slice(1)} ${escapeHtml(key.nickname)}`;
          return `<button class="icon-button" type="button" data-key-action="${action}" data-key-id="${key.id}" aria-label="${label}" data-tooltip="${label}">${icon(action as Icon)}</button>`;
        }).join("")}
      </div>
    </li>`).join("");
  }

  function setReveal(reveal: boolean) {
    const field = element<HTMLInputElement>("key-value");
    field.toggleAttribute("data-masked", !reveal);
    if (!CSS.supports("-webkit-text-security", "disc")) field.type = reveal ? "text" : "password";
    const button = element("reveal-key");
    button.setAttribute("aria-pressed", String(reveal));
    button.textContent = reveal ? "Hide API key" : "Show API key";
  }

  function editKey(action: "add" | "rename" | "replace", key?: KeySummary) {
    keyEditor = { action, key };
    showError("keys-error");
    const name = element<HTMLInputElement>("key-name");
    const value = element<HTMLInputElement>("key-value");
    name.value = key?.nickname ?? "";
    name.setCustomValidity("");
    name.disabled = action === "replace";
    value.value = "";
    setReveal(false);
    value.disabled = action === "rename";
    element("key-name-row").hidden = name.disabled;
    element("key-value-row").hidden = value.disabled;
    element("key-value-row").querySelector("label")!.textContent = action === "replace" ? "New API key" : "API key";
    element("save-key").textContent = action === "rename" ? "Save name" : action === "replace" ? "Replace key" : "Add Key";
    element("add-key").setAttribute("aria-expanded", "true");
    renderKeysView();
    (action === "replace" ? value : name).focus();
  }

  function closeKeyEditor() {
    keyEditor = undefined;
    element<HTMLInputElement>("key-value").value = "";
    setReveal(false);
    element("add-key").setAttribute("aria-expanded", "false");
    renderKeysView();
  }

  async function refreshKeys() {
    await loadKeys();
    renderKeysView();
    onKeysChanged();
  }

  async function deleteKey(key: KeySummary) {
    try {
      const route = `/api/provider-keys/${key.id}`;
      const impact = await request<KeyImpact>(`${route}/delete-impact`);
      if (!isOpen()) return;
      if (impact.busy) { showError("keys-error", "Pause Worlds using this key before deleting it."); return; }
      const names = impact.worlds.map(world => world.name).join(", ");
      previewDialog({ title: "Delete API key?", detail: names
        ? `Remove “${key.nickname}” from ${names}?` : `Remove “${key.nickname}”?`, danger: true }, async () => {
        try {
          await request(`${route}/delete`, { impact });
          await Promise.all([refreshKeys(), loadWorlds()]);
          onWorldsReloaded();
          element("add-key").focus();
        } catch (error) { showToast(error); }
      });
    } catch (error) { showToast(error); }
  }

  function initialize() {
    element("view-keys").addEventListener("click", () => { showKeyUse = false; renderKeysView(); });
    element("view-key-worlds").addEventListener("click", () => { showKeyUse = true; closeKeyEditor(); });
    element("add-key").addEventListener("click", () => editKey("add"));
    element("cancel-key").addEventListener("click", () => { closeKeyEditor(); element("add-key").focus(); });
    element("reveal-key").addEventListener("click", () => setReveal(element("key-value").hasAttribute("data-masked")));
    element("key-list").addEventListener("click", event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("[data-key-action]");
      if (!button || keysPending) return;
      const key = keySettings.keys.find(item => item.id === button.dataset.keyId);
      if (!key) return;
      const action = button.dataset.keyAction;
      if (action === "rename" || action === "replace") editKey(action, key);
      if (action === "delete") void deleteKey(key);
    });
    const keyName = element<HTMLInputElement>("key-name");
    const keyValue = element<HTMLInputElement>("key-value");
    element("key-form").addEventListener("submit", async event => {
      event.preventDefault();
      if (!keyEditor || keysPending) return;
      const { action, key } = keyEditor;
      keysPending = true;
      showError("keys-error");
      try {
        await request(key ? `/api/provider-keys/${key.id}/${action}` : "/api/provider-keys",
          { nickname: keyName.value, secret: keyValue.value });
        closeKeyEditor();
        await refreshKeys().catch(error => showToast(error));
        if (isOpen()) element("add-key").focus();
      } catch (error) { showDrawerError("keys-error", error); }
      finally { keysPending = false; }
    });
  }

  return { initialize, renderKeysView, closeKeyEditor, refreshKeys };
}
