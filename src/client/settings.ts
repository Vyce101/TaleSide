import type { ChatSettings, KeyImpact, KeySummary, ProfileSettings, World, Wrappers } from "../shared/types.js";
import { updateWorld, syncWorlds, previewDialog, refreshComposer, state } from "./app.js";
import { keySettings, loadKeys, loadWorlds, request, worldRoute } from "./data.js";
import { element, showError } from "./dom.js";
import { setSurfaceVisible, slideFrames } from "./motion.js";
import { renderKeyPicker } from "./key-picker.js";
import { escapeHtml, icon, type Icon } from "./view.js";
import { updateWorldEditorKeys } from "./world-editor.js";

type NumericSetting = "input_limit" | "output_limit" | "retrieved_chunks" | "minimum_similarity" | "chunk_overlap" | "messages_to_embed";
type Slider = { id: string; setting: NumericSetting; label: string; value: number; min: number; range: number; limit?: number; step?: number; unit?: string };

const retrievalControls: Omit<Slider, "value">[] = [
  { id: "retrieved-chunks", setting: "retrieved_chunks", label: "Retrieved chunks", min: 1, range: 30 },
  { id: "minimum-similarity", setting: "minimum_similarity", label: "Minimum similarity", min: 0, range: 1, limit: 1, step: 0.01 },
  { id: "chunk-overlap", setting: "chunk_overlap", label: "Chunk overlap", unit: "characters", min: 0, range: 1000 },
  { id: "messages-to-embed", setting: "messages_to_embed", label: "Messages to embed", min: 1, range: 10 },
];
let profiles: ProfileSettings;
let working: ChatSettings;
let profilePending = false;

export function currentChatSettings() {
  if (!working) return;
  return { ...working, chat_key_ids: working.chat_key_ids.filter(id => keySettings.keys.some(key => key.id === id)) };
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



function renderProfilePicker() {
  const select = element<HTMLSelectElement>("chat-profile");
  select.replaceChildren(...profiles.profiles.map(profile => new Option(profile.name, profile.id, false, profile.id === profiles.selected)));
  select.disabled = profilePending;
  for (const button of element("profile-actions").querySelectorAll<HTMLButtonElement>("button")) {
    button.disabled = profilePending || (button.id === "delete-profile" && profiles.profiles.length < 2);
  }
}

function renderChatKey() {
  if (!working) return;
  renderKeyPicker("chat-key", working.chat_key_ids, ids => { working.chat_key_ids = ids; refreshComposer(); });
}

function loadWorkingProfile() {
  working = structuredClone(profiles.profiles.find(profile => profile.id === profiles.selected)?.settings ?? profiles.defaults);
  const model = profiles.models.find(model => model.id === working.model) ?? profiles.models[0];
  const modelSelect = element<HTMLSelectElement>("chat-model");
  modelSelect.replaceChildren(...profiles.models.map(item => new Option(item.id, item.id)));
  modelSelect.value = model.id;
  const sliders: Slider[] = [
    { id: "input-limit", setting: "input_limit", label: "Input limit", unit: "tokens", value: profiles.defaults.input_limit, min: 256,
      range: model.context_limit, limit: model.context_limit },
    { id: "output-limit", setting: "output_limit", label: "Output limit", unit: "tokens", value: profiles.defaults.output_limit, min: 256,
      range: model.max_output, limit: model.max_output },
  ];
  renderSliders("model-limits", sliders);
  renderSliders("retrieval-controls", retrievalControls.map(control => ({ ...control, value: profiles.defaults[control.setting] })));
  element<HTMLSelectElement>("thinking-level").value = working.thinking_level;
  element<HTMLInputElement>("send-thinking").checked = working.thought_signatures;
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
  } catch (error) { showError("settings-error", error); }
  finally { profilePending = false; renderProfilePicker(); }
}

function handleProfileAction(action: string) {
  const profile = profiles.profiles.find(item => item.id === profiles.selected);
  if (!profile) return;
  if (action === "save") void changeProfile("save", { id: profile.id, settings: currentChatSettings() }, false);
  if (action === "save-as" || action === "rename") {
    const rename = action === "rename";
    previewDialog({ title: rename ? "Rename chat profile" : "Save chat profile as", initialName: rename ? profile.name : "" },
      name => changeProfile(rename ? "rename" : "create", { id: profile.id, name, settings: currentChatSettings() }, !rename));
  }
  if (action === "delete") {
    previewDialog({ title: "Delete chat profile?", detail: `Remove “${profile.name}”?`, danger: true },
      () => changeProfile("delete", { id: profile.id }, true));
  }
}

export async function initializeSettings() {
  element("profile-actions").innerHTML = `
    <button type="button" class="icon-button" aria-label="Save profile" data-tooltip="Save profile" data-profile-action="save">${icon("save")}</button>
    <button type="button" class="icon-button" aria-label="Save profile as" data-tooltip="Save profile as" data-profile-action="save-as">${icon("duplicate")}</button>
    <button type="button" class="icon-button" aria-label="Rename chat profile" data-tooltip="Rename chat profile" data-profile-action="rename">${icon("rename")}</button>
    <button type="button" class="icon-button" id="delete-profile" aria-label="Delete chat profile" data-tooltip="Delete chat profile" data-profile-action="delete">${icon("delete")}</button>`;
  element<HTMLSelectElement>("chat-profile").addEventListener("change", event =>
    void changeProfile("select", { id: (event.target as HTMLSelectElement).value }, true));
  for (const button of element("profile-actions").querySelectorAll<HTMLButtonElement>("button")) {
    button.addEventListener("click", () => handleProfileAction(button.dataset.profileAction!));
  }
  const thinking = element<HTMLSelectElement>("thinking-level");
  thinking.addEventListener("change", () => { working.thinking_level = thinking.value; });
  const signature = element<HTMLInputElement>("send-thinking");
  signature.addEventListener("change", () => { working.thought_signatures = signature.checked; });
  profiles = await request<ProfileSettings>("/api/tale-settings");
  loadWorkingProfile();
}
