import { renderPrompts } from "./prompts.js";
import { GEMMA } from "../shared/models.js";
import type { ChatSettings, KeyImpact, KeySummary, ProfileSettings, World, Wrappers } from "../shared/types.js";
import { updateWorld, syncWorlds, previewDialog, refreshComposer, state } from "./app.js";
import { keySettings, loadKeys, loadWorlds, request, worldRoute } from "./data.js";
import { showDrawerError, showToast } from "./toasts.js";
import { element, showError } from "./dom.js";
import { setSurfaceVisible, slideFrames } from "./motion.js";
import { renderKeyPicker } from "./key-picker.js";
import { escapeHtml, icon, type Icon } from "./view.js";
import { updateWorldEditorKeys } from "./world-editor.js";

type NumericSetting = "input_limit" | "output_limit" | "chunk_budget" | "minimum_similarity" | "chunk_overlap" | "messages_to_embed";
type Slider = { id: string; setting: NumericSetting; label: string; value: number; min: number; range: number; limit?: number; step?: number; unit?: string };

const retrievalControls: Omit<Slider, "value">[] = [
  { id: "chunk-budget", setting: "chunk_budget", label: "Max Chunk RAG budget", min: 1, range: 80000, unit: "characters" },
  { id: "minimum-similarity", setting: "minimum_similarity", label: "Minimum similarity", min: 0, range: 1, limit: 1, step: 0.01 },
  { id: "chunk-overlap", setting: "chunk_overlap", label: "Chunk overlap", unit: "characters", min: 0, range: 1000 },
  { id: "messages-to-embed", setting: "messages_to_embed", label: "Messages to embed", min: 1, range: 10 },
];
const wrappers = [["World Description", "world_description"], ["World Info", "world_info"], ["Persona", "persona"], ["Retrieved Passages", "retrieved_passages"], ["Chat History", "chat_history"]] as const;
let profiles: ProfileSettings;
let working: ChatSettings;
const modelChoices = new Map<string, Pick<ChatSettings, "thinking_level" | "thought_signatures" | "input_limit" | "output_limit">>();
let keyEditor: { action: "add" | "rename" | "replace"; key?: KeySummary } | undefined;
let showKeyUse = false;
let profilePending = false;
let keysPending = false;
let retrievalPending = false;

export function currentChatSettings(includeDraft = false) {
  if (!working) return;
  const saved = profiles.profiles.find(profile => profile.id === profiles.selected)?.settings ?? profiles.defaults;
  return { ...working, prompts: includeDraft ? working.prompts : saved.prompts,
    wrappers: includeDraft ? working.wrappers : saved.wrappers, chat_key_ids: working.chat_key_ids.filter(id => keySettings.keys.some(key => key.id === id)) };
}

function renderSliders(container: string, settings: Slider[]) {
  element(container).innerHTML = settings.map(({ id, label, min, range, limit, step = 1, value, setting, unit }) => `<div class="slider-setting">
    <div class="setting-label">
      <label for="${id}">${label}${unit ? ` (${unit})` : ""}</label>
      <small id="${id}-default">Default ${value.toLocaleString("en-GB")}</small>
    </div>
    <div class="numeric-setting">
      <input id="${id}" type="range" min="${min}" max="${range}" step="${step}" value="${working[setting]}" aria-describedby="${id}-default">
      <input id="${id}-number" type="number" autocomplete="off" min="${min}" ${limit === undefined ? "" : `max="${limit}"`}
        step="${step}" value="${working[setting]}" aria-label="${label}${unit ? ` in ${unit}` : ""} as a number" aria-describedby="${id}-default" data-profile-field>
    </div>
  </div>`).join("");
  for (const { id, setting } of settings) {
    const slider = element<HTMLInputElement>(id);
    const number = element<HTMLInputElement>(`${id}-number`);
    slider.addEventListener("input", () => { number.value = slider.value; working[setting] = slider.valueAsNumber; });
    number.addEventListener("input", () => { if (number.value) slider.value = number.value; });
    number.addEventListener("change", () => {
      const min = Number(number.min);
      const max = number.max ? Number(number.max) : Infinity;
      const value = number.value ? Number(number.value) : slider.valueAsNumber;
      const bounded = Math.min(max, Math.max(min, value));
      number.value = number.step === "1" ? String(Math.round(bounded)) : bounded.toFixed(2);
      slider.value = number.value;
      working[setting] = number.valueAsNumber;
    });
  }
}



function renderWrappers() {
  element("wrapper-controls").innerHTML = wrappers.map(([label, tag]) => `<section class="wrapper-pair">
    <div class="wrapper-heading"><h4>${label}</h4><button type="button" class="quiet-button" data-reset-wrapper="${tag}">Reset</button></div>
    <div class="settings-grid">
      <textarea id="${tag}-open" aria-label="${label} opening wrapper" rows="2" autocomplete="off"></textarea>
      <textarea id="${tag}-close" aria-label="${label} closing wrapper" rows="2" autocomplete="off"></textarea>
    </div>
  </section>`).join("");
  for (const [, tag] of wrappers) {
    const open = element<HTMLTextAreaElement>(`${tag}-open`);
    const close = element<HTMLTextAreaElement>(`${tag}-close`);
    [open.value, close.value] = working.wrappers[tag];
    const change = () => { working.wrappers[tag] = [open.value, close.value]; };
    open.addEventListener("input", change);
    close.addEventListener("input", change);
    element("wrapper-controls").querySelector(`[data-reset-wrapper="${tag}"]`)!.addEventListener("click", () => {
      [open.value, close.value] = profiles.defaults.wrappers[tag];
      change();
    });
  }
}

function renderProfilePicker() {
  const select = element<HTMLSelectElement>("chat-profile");
  select.replaceChildren(...profiles.profiles.map(profile => new Option(profile.name, profile.id, false, profile.id === profiles.selected)));
  select.disabled = profilePending;
  const locked = profiles.profiles.find(profile => profile.id === profiles.selected)?.locked;
  for (const button of element("profile-actions").querySelectorAll<HTMLButtonElement>("button")) {
    button.disabled = profilePending || !!locked && ["rename", "delete"].includes(button.dataset.profileAction!);
  }
}

function renderChatKey() {
  if (!working) return;
  renderKeyPicker("chat-key", working.chat_key_ids, ids => { working.chat_key_ids = ids; refreshComposer(); });
}

function renderModelSettings() {
  const model = profiles.models.find(model => model.id === working.model)!;
  const sliders: Slider[] = [
    { id: "input-limit", setting: "input_limit", label: "Input limit", unit: "tokens", value: model.context_limit, min: 256,
      range: model.context_limit, limit: model.context_limit },
    { id: "output-limit", setting: "output_limit", label: "Output limit", unit: "tokens", value: model.max_output, min: 256,
      range: model.max_output, limit: model.max_output },
  ];
  renderSliders("model-limits", sliders);
  if (profiles.profiles.find(profile => profile.id === profiles.selected)?.locked) {
    for (const input of element("model-limits").querySelectorAll<HTMLInputElement>("input")) input.disabled = true;
  }
  const thinking = element<HTMLSelectElement>("thinking-level");
  thinking.replaceChildren(...model.thinking_levels.map(level => new Option(level === "XHIGH" ? "Extra high"
    : level[0] + level.slice(1).toLowerCase(), level)));
  thinking.value = working.thinking_level;
  element<HTMLInputElement>("send-thinking").checked = working.thought_signatures;
  element("send-thinking-note").textContent = model.id === GEMMA
    ? "Send Gemma’s displayed thinking with follow-up requests. Google recommends leaving this off."
    : "Send the model’s thinking signature back with follow-up requests.";
}

function loadWorkingProfile() {
  working = structuredClone(profiles.profiles.find(profile => profile.id === profiles.selected)?.settings ?? profiles.defaults);
  modelChoices.clear();
  const modelSelect = element<HTMLSelectElement>("chat-model");
  modelSelect.replaceChildren(...profiles.models.map(item => new Option(item.label, item.id)));
  modelSelect.value = working.model;
  renderModelSettings();
  renderSliders("retrieval-controls", retrievalControls.map(control => ({ ...control, value: profiles.defaults[control.setting] })));
  renderWrappers();
  const locked = !!profiles.profiles.find(profile => profile.id === profiles.selected)?.locked;
  for (const id of ["wrapper-controls", "retrieval-controls", "model-limits"]) {
    for (const control of element(id).querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>("input, button, textarea")) {
      control.disabled = locked;
    }
  }
  renderPrompts(working.prompts, locked);
  renderChatKey();
  renderProfilePicker();
  refreshComposer();
}

async function changeProfile(action: string, input: object, reload: boolean) {
  if (!profiles || profilePending) return;
  profilePending = true;
  renderProfilePicker();
  showError("settings-error");
  try {
    profiles = await request<ProfileSettings>(`/api/chat-profiles/${action}`, input);
    if (reload) loadWorkingProfile();
    else refreshComposer();
    if (action === "save") showToast("Chat profile saved.", { temporary: true, success: true });
  } catch (error) { showDrawerError("settings-error", error); }
  finally { profilePending = false; renderProfilePicker(); }
}

function handleProfileAction(action: string) {
  const profile = profiles.profiles.find(item => item.id === profiles.selected);
  if (!profile) return;
  if (action === "save") void changeProfile("save", { id: profile.id, settings: currentChatSettings(true) }, false);
  if (action === "save-as" || action === "rename") {
    const rename = action === "rename";
    previewDialog({ title: rename ? "Rename chat profile" : "Save chat profile as", initialName: rename ? profile.name : "" },
      name => changeProfile(rename ? "rename" : "create", { id: profile.id, name, settings: currentChatSettings(true) }, !rename));
  }
  if (action === "delete") {
    previewDialog({ title: "Delete chat profile?", detail: `Remove “${profile.name}”?`, danger: true },
      () => changeProfile("delete", { id: profile.id }, true));
  }
}

export function renderWorldContext() {
  const world = state.world;
  element("world-context").hidden = !world;
  if (!world) return;
  element("world-context-name").textContent = world.name;
  element<HTMLSelectElement>("world-embedding-model").options[0].text = world.model;
  element("world-index-details").textContent = `${world.max_token_limit.toLocaleString("en-GB")} tokens max · ${world.dimensions.toLocaleString("en-GB")} dimensions`;
  renderKeyPicker("world-retrieval-key", world.retrieval_key_ids, async ids => {
    retrievalPending = true;
    const picker = element("world-retrieval-key");
    picker.inert = true;
    showError("settings-error");
    try { updateWorld(await request<World>(`${worldRoute(world.id)}/retrieval-key`, { key_ids: ids })); }
    catch (error) { showDrawerError("settings-error", error); }
    finally { retrievalPending = false; picker.inert = false; renderWorldContext(); }
  }, retrievalPending);
}

export function renderKeysView() {
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

export function closeKeyEditor() {
  keyEditor = undefined;
  element<HTMLInputElement>("key-value").value = "";
  setReveal(false);
  element("add-key").setAttribute("aria-expanded", "false");
  renderKeysView();
}

export async function refreshKeys() {
  await loadKeys();
  renderKeysView();
  renderChatKey();
  if (state.panel === "settings") renderWorldContext();
  updateWorldEditorKeys();
  refreshComposer();
}

async function deleteKey(key: KeySummary) {
  try {
    const route = `/api/provider-keys/${key.id}`;
    const impact = await request<KeyImpact>(`${route}/delete-impact`);
    if (state.panel !== "keys") return;
    if (impact.busy) { showError("keys-error", "Pause Worlds using this key before deleting it."); return; }
    const names = impact.worlds.map(world => world.name).join(", ");
    previewDialog({ title: "Delete API key?", detail: names
      ? `Remove “${key.nickname}” from ${names}?` : `Remove “${key.nickname}”?`, danger: true }, async () => {
      try {
        await request(`${route}/delete`, { impact });
        await Promise.all([refreshKeys(), loadWorlds()]);
        syncWorlds();
        element("add-key").focus();
      } catch (error) { showToast(error); }
    });
  } catch (error) { showToast(error); }
}

function restoreSettingsSections() {
  for (const section of element("settings-panel").querySelectorAll<HTMLDetailsElement>(":scope > details[id]")) {
    const key = `taleside:${section.id}:open`;
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) section.open = saved === "true";
      section.addEventListener("toggle", () => localStorage.setItem(key, String(section.open)));
    } catch { /* A blocked browser storage setting should not prevent opening Tale Settings. */ }
  }
}

export async function initializeSettings() {
  restoreSettingsSections();
  element("profile-actions").innerHTML = `
    <button type="button" class="icon-button" aria-label="Save preset" data-tooltip="Save preset" data-profile-action="save">${icon("save")}</button>
    <button type="button" class="icon-button" aria-label="Save preset as" data-tooltip="Save preset as" data-profile-action="save-as">${icon("duplicate")}</button>
    <button type="button" class="icon-button" aria-label="Rename chat profile" data-tooltip="Rename chat profile" data-profile-action="rename">${icon("rename")}</button>
    <button type="button" class="icon-button" id="delete-profile" aria-label="Delete chat profile" data-tooltip="Delete chat profile" data-profile-action="delete">${icon("delete")}</button>`;
  element<HTMLSelectElement>("chat-profile").addEventListener("change", event =>
    void changeProfile("select", { id: (event.target as HTMLSelectElement).value }, true));
  for (const button of element("profile-actions").querySelectorAll<HTMLButtonElement>("button")) {
    button.addEventListener("click", () => handleProfileAction(button.dataset.profileAction!));
  }
  element<HTMLSelectElement>("chat-model").addEventListener("change", event => {
    const id = (event.target as HTMLSelectElement).value;
    const model = profiles.models.find(item => item.id === id);
    if (!model || id === working.model) return;
    const { thinking_level, thought_signatures, input_limit, output_limit } = working;
    modelChoices.set(working.model, { thinking_level, thought_signatures, input_limit, output_limit });
    Object.assign(working, modelChoices.get(id) ?? {
      thinking_level: model.default_thinking, thought_signatures: model.replay_thinking,
      input_limit: model.context_limit, output_limit: model.max_output,
    }, { model: id });
    renderModelSettings();
  });
  const thinking = element<HTMLSelectElement>("thinking-level");
  thinking.addEventListener("change", () => { working.thinking_level = thinking.value; });
  const signature = element<HTMLInputElement>("send-thinking");
  signature.addEventListener("change", () => { working.thought_signatures = signature.checked; });
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
      if (state.panel === "keys") element("add-key").focus();
    } catch (error) { showDrawerError("keys-error", error); }
    finally { keysPending = false; }
  });
  profiles = await request<ProfileSettings>("/api/tale-settings");
  loadWorkingProfile();
}
