import type { ChatSettings, KeyImpact, KeySummary, ProfileSettings, World, Wrappers } from "../shared/types.js";
import { updateWorld, syncWorlds, previewDialog, refreshComposer, state } from "./app.js";
import { keySettings, loadKeys, loadWorlds, request, worldRoute } from "./data.js";
import { element, showError } from "./dom.js";
import { setSurfaceVisible, slideFrames } from "./motion.js";
import { renderKeyPicker } from "./key-picker.js";
import { escapeHtml, icon, type Icon } from "./view.js";
import { updateWorldEditorKeys } from "./world-editor.js";

let profiles: ProfileSettings;
let working: ChatSettings;
let profilePending = false;

export function currentChatSettings() {
  if (!working) return;
  return { ...working, chat_key_ids: working.chat_key_ids.filter(id => keySettings.keys.some(key => key.id === id)) };
}

function renderProfilePicker() {
  const select = element<HTMLSelectElement>("chat-profile");
  select.replaceChildren(...profiles.profiles.map(profile => new Option(profile.name, profile.id, false, profile.id === profiles.selected)));
  select.disabled = profilePending;
  for (const button of element("profile-actions").querySelectorAll<HTMLButtonElement>("button")) {
    button.disabled = profilePending || (button.id === "delete-profile" && profiles.profiles.length < 2);
  }
}

function loadWorkingProfile() {
  working = structuredClone(profiles.profiles.find(profile => profile.id === profiles.selected)?.settings ?? profiles.defaults);
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
  profiles = await request<ProfileSettings>("/api/tale-settings");
  loadWorkingProfile();
}
