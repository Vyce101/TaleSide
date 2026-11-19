import { initPicker } from "../picker.js";
import { editName, element, errorText, fillSelect } from "./controls.js";

const wrapperNames = { world_info: "World Info", retrieved_passages: "Retrieved Passages", chat_history: "Chat History" };
const modelLevels = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", XHIGH: "XHigh" };

export function initTaleSettings({ request, addKey, onWorldChange, confirm }) {
  const drawer = element("tale-settings");
  const body = drawer.querySelector(".tale-settings-body");
  const error = element("tale-settings-error");
  const profile = element("chat-profile");
  const modelSelect = element("chat-model");
  const worldModel = element("tale-embedding-model");
  const worldSpecs = element("tale-embedding-specs");
  const chatKeyField = element("chat-key-selection");
  const add = element("add-chat-key");
  const chatKey = initPicker("chat-key", "chat-key-label", keyIds => saveChatKeys(keyIds).catch(() => {}), {
    multiple: true, scrollContainer: body,
  });
  const hubKey = initPicker("hub-retrieval-key", "hub-retrieval-key-label", changeRetrieval, { multiple: true });
  const drawerKey = initPicker("drawer-retrieval-key", "drawer-retrieval-key-label", changeRetrieval, {
    multiple: true, scrollContainer: body,
  });
  const controls = [...drawer.querySelectorAll("[data-setting]")];
  const wrappers = {};
  let state;
  let world;
  let keys = [];
  let embeddingModels = [];
  let saving = Promise.resolve();
  let loading = 0;
  let retrievalChange;
  let pendingChatKeyIds;
  let profileEdit;
  let opener;

  for (const [id, name] of Object.entries(wrapperNames)) {
    const group = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = name;
    const inputs = ["Prefix", "Suffix"].map(label => {
      const input = document.createElement("input");
      input.setAttribute("aria-label", `${name} ${label}`);
      input.spellcheck = false;
      input.addEventListener("change", () => {
        const values = Object.fromEntries(Object.entries(wrappers).map(([name, pair]) =>
          [name, pair.map(input => input.value)]));
        update({ wrappers: values });
      });
      return input;
    });
    wrappers[id] = inputs;
    group.append(legend, ...inputs);
    element("wrapper-pairs").append(group);
  }

  function renderRetrieval() {
    const model = embeddingModels.find(model => model.id === world?.model);
    const compatible = keys.filter(key => key.provider === model?.provider);
    const disabled = !world || !compatible.length;
    const selected = retrievalChange && retrievalChange.worldId === world?.id
      ? retrievalChange.keyIds : world?.retrieval_key_ids ?? [];
    for (const picker of [hubKey, drawerKey]) {
      picker.update([{ items: compatible.map(key => ({ id: key.id, label: key.nickname })) }], selected, {
        disabled, saving: Boolean(retrievalChange), placeholder: compatible.length ? "Select keys" : "No compatible keys",
      });
    }
    element("tale-settings-world").hidden = !world;
    worldModel.textContent = world?.model ?? "";
    worldSpecs.textContent = world
      ? `${world.dimensions.toLocaleString()} dimensions · ${world.max_token_limit.toLocaleString()} max tokens`
      : "";
  }

  async function changeRetrieval(keyIds) {
    if (!world || retrievalChange) return;
    const worldId = world.id;
    retrievalChange = { worldId, keyIds };
    renderRetrieval();
    try {
      await request(`/api/worlds/${worldId}/retrieval-key`, { method: "POST", json: { key_ids: keyIds } });
      await onWorldChange();
    } catch (failure) {
      errorText(drawer.open ? error : element("tales-error"), failure.message);
    } finally {
      retrievalChange = null;
      renderRetrieval();
    }
  }

  function render() {
    renderRetrieval();
    if (!state) return;
    const { settings, profiles, models } = state;
    const model = models.find(model => model.id === settings.model);
    fillSelect(profile, profiles, settings.profile_id, profiles.length ? "Select profile" : "No saved profiles");
    for (const id of ["save", "rename", "delete"]) {
      element(`profile-${id}`).disabled = !settings.profile_id || Boolean(profileEdit);
    }
    element("profile-create").disabled = Boolean(profileEdit);
    const providers = new Map();
    for (const option of models) {
      if (!providers.has(option.provider)) providers.set(option.provider, []);
      providers.get(option.provider).push(option);
    }
    const grouped = [...providers].sort(([left], [right]) =>
      Number(keys.some(key => key.provider === right)) - Number(keys.some(key => key.provider === left)));
    const groups = JSON.stringify(grouped);
    if (modelSelect.dataset.options !== groups) {
      modelSelect.replaceChildren(...grouped.map(([, options]) => {
        const group = document.createElement("optgroup");
        group.label = options[0].provider_name;
        group.append(...options.map(option => new Option(option.id, option.id)));
        return group;
      }));
      modelSelect.dataset.options = groups;
    }
    const compatible = keys.filter(key => key.provider === model.provider);
    const compatibleIds = new Set(compatible.map(key => key.id));
    chatKeyField.hidden = !compatible.length;
    add.hidden = Boolean(compatible.length);
    add.textContent = `＋ Add ${model.provider_name} Key`;
    chatKey.update([{ items: compatible.map(key => ({ id: key.id, label: key.nickname })) }],
      (pendingChatKeyIds ?? settings.chat_key_ids).filter(id => compatibleIds.has(id)),
      { disabled: !compatible.length, saving: Boolean(pendingChatKeyIds), placeholder: "Select keys" });
    element("thinking-level").hidden = !model.thinking_levels?.length;
    const levels = element("thinking-level-options");
    if (levels.dataset.model !== model.id) {
      levels.replaceChildren(...(model.thinking_levels ?? []).map(level => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = modelLevels[level] ?? level;
        button.value = level;
        button.addEventListener("click", () => update({ thinking_level: level }));
        return button;
      }));
      levels.dataset.model = model.id;
    }
    for (const button of levels.children) {
      button.setAttribute("aria-pressed", String(button.value === settings.thinking_level));
    }
    element("thought-signatures-control").hidden = !model.thought_signatures;
    drawer.querySelector('[data-setting="output_limit"]').max = model.max_output;
    for (const input of controls) {
      if (input.type === "checkbox") input.checked = settings[input.dataset.setting];
      else if (input.type !== "number" || input !== document.activeElement) input.value = settings[input.dataset.setting] ?? "";
    }
    for (const [id, pair] of Object.entries(wrappers)) {
      pair.forEach((input, index) => {
        if (input !== document.activeElement) input.value = settings.wrappers[id][index];
      });
    }
  }

  function save(path, json) {
    ++loading;
    const action = saving.then(async () => {
      errorText(error);
      state = await request(path, { method: "POST", json });
      render();
    });
    saving = action.catch(failure => {
      errorText(error, failure.message);
      render();
    });
    return action;
  }

  function update(changes) {
    save("/api/tale-settings", changes);
  }

  async function saveChatKeys(keyIds) {
    pendingChatKeyIds = keyIds;
    render();
    try {
      await save("/api/tale-settings", { chat_key_ids: keyIds });
    } finally {
      pendingChatKeyIds = null;
      render();
    }
  }

  function profileAction(action, fields) {
    return save(`/api/chat-profiles/${action}`, fields);
  }

  function editProfile(action) {
    if (profileEdit || !state) return;
    const id = state.settings.profile_id;
    const name = action === "rename" ? state.profiles.find(item => item.id === id).name : "";
    profileEdit = editName(profile, name, "Profile name", value => profileAction(action, { id, name: value }), () => {
      profileEdit = null;
      render();
      profile.focus();
    }, message => errorText(error, message));
    render();
  }

  for (const input of controls) input.addEventListener("change", () => {
    if (input.type === "number" && !Number.isFinite(input.valueAsNumber)) {
      input.value = state.settings[input.dataset.setting];
      return;
    }
    const value = input.type === "checkbox" ? input.checked
      : input.type === "number" ? input.valueAsNumber : input.value || null;
    update({ [input.dataset.setting]: value });
  });
  for (const input of controls.filter(input => input.type === "number")) {
    input.addEventListener("blur", () => saving.then(() => {
      if (document.activeElement !== input) input.value = state.settings[input.dataset.setting];
    }));
  }
  profile.addEventListener("change", () => profileAction("select", { id: profile.value || null }));
  element("profile-save").addEventListener("click", () => profileAction("save", { id: profile.value }));
  element("profile-create").addEventListener("click", () => editProfile("create"));
  element("profile-rename").addEventListener("click", () => editProfile("rename"));
  element("profile-delete").addEventListener("click", async () => {
    const { id, name } = state.profiles.find(item => item.id === state.settings.profile_id);
    if (await confirm(`Delete “${name}”?`, "This removes the saved Chat Profile.", "Cancel", "Delete Profile", true)) {
      profileAction("delete", { id });
    }
  });
  element("reset-wrappers").addEventListener("click", () => update({ wrappers: state.wrapper_defaults }));
  add.addEventListener("click", () => addKey({
    onAdded: key => saveChatKeys([key.id]),
    restoreFocus: () => (chatKeyField.hidden ? add : chatKey).focus(),
  }));
  element("close-tale-settings").addEventListener("click", () => drawer.close());
  drawer.addEventListener("click", event => {
    if (event.target === drawer && event.clientX < drawer.getBoundingClientRect().left) drawer.close();
  });
  drawer.addEventListener("close", () => {
    chatKey.close();
    drawerKey.close();
    profileEdit?.remove();
    profileEdit = null;
    profile.hidden = false;
    render();
    opener?.focus({ preventScroll: true });
  });

  async function refresh() {
    const revision = ++loading;
    await saving;
    const data = await request("/api/tale-settings");
    if (revision === loading) {
      state = data;
      render();
    }
  }

  return {
    world(current) {
      if (world?.id !== current?.id) {
        hubKey.close(false, false);
        drawerKey.close(false, false);
      }
      world = current;
      renderRetrieval();
    },
    keys(options) {
      keys = options.keys;
      embeddingModels = options.models;
      render();
    },
    async open(trigger, focus) {
      if (drawer.open) return;
      opener = trigger;
      for (const section of drawer.querySelectorAll("details")) section.open = true;
      errorText(error);
      drawer.setAttribute("aria-busy", "true");
      body.inert = true;
      drawer.showModal();
      try {
        await refresh();
        if (!drawer.open) return;
        body.inert = false;
        if (focus === "Retrieval Key") drawerKey.focus();
        if (focus === "Chat Key") (add.hidden ? chatKey : add).focus();
      } catch (failure) {
        errorText(error, failure.message);
      } finally {
        drawer.removeAttribute("aria-busy");
      }
    },
    close() {
      if (drawer.open) drawer.close();
    },
  };
}
