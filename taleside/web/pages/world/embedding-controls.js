import { initPicker } from "../picker.js";

function groupModels(models, keys) {
  const byName = (first, second) => first.localeCompare(second);
  const providers = Object.values(Object.groupBy(models, model => model.provider));
  const groups = providers.map(providerModels => {
    const { provider, provider_name: name } = providerModels[0];
    const count = keys.filter(key => key.provider === provider).length;
    return {
      name, count,
      hint: count ? `${count} ${count === 1 ? "key" : "keys"} ready` : "No keys added",
      items: providerModels.map(({ id }) => ({ id, label: id })).sort((a, b) => byName(a.id, b.id)),
    };
  }).sort((a, b) => Number(Boolean(b.count)) - Number(Boolean(a.count)) || byName(a.name, b.name));
  const unconfigured = groups.findIndex(group => !group.count);
  if (unconfigured > 0) groups[unconfigured].divider = true;
  return groups;
}

export function initEmbeddingControls({ chooseModel, chooseKey, addKey }) {
  const spec = document.getElementById("embedding-spec");
  const keyPicker = document.getElementById("embedding-key");
  const keyDescription = document.getElementById("embedding-key-description");
  const add = document.getElementById("add-provider-key");
  const rows = document.querySelector(".settings-rows");
  const modelControl = initPicker("embedding-model", "embedding-model-label", chooseModel);
  const keyControl = initPicker("embedding-key", "embedding-key-label", chooseKey);
  add.addEventListener("click", addKey);

  return {
    focusKey() {
      if (add.hidden) keyControl.focus();
      else add.focus();
    },
    show({ options, selection, world, busy, changingKey, jobPending }) {
      const models = options?.models ?? [];
      const keys = options?.keys ?? [];
      const model = models.find(item => item.id === selection?.model);
      const providerName = model?.provider_name ?? "Google Gemini";
      const specs = world ?? model;
      const demo = world?.id.startsWith("demo-");
      const active = busy || jobPending === "resume" || ["creating", "pausing"].includes(world?.status);
      const keyLocked = active || changingKey;
      const providerKeys = keys.filter(key => key.provider === model?.provider);
      const missingKeys = Boolean(model && !providerKeys.length && !demo);
      const keyItems = providerKeys.map(key => ({ id: key.id, label: key.nickname }));

      rows.toggleAttribute("data-core-locked", Boolean(world || busy));
      rows.toggleAttribute("data-key-locked", Boolean(active));
      document.getElementById("settings-lock").textContent = active ? "Locked while creating"
        : world ? "Core settings locked" : "Locked once creation starts";
      spec.textContent = specs ? `${providerName} · ${specs.dimensions.toLocaleString()} dimensions · ${specs.max_token_limit.toLocaleString()} max tokens` : "";
      keyDescription.textContent = demo ? "Demo World" : `${providerName} key for embedding (locked only while actively creating)`;
      modelControl.update(groupModels(models, keys), selection?.model, {
        disabled: Boolean(world || busy || !models.length),
        placeholder: selection?.model ?? "Loading models…",
      });
      keyControl.update([{ name: providerName, items: keyItems }], demo ? null : selection?.key_id, {
        disabled: Boolean(keyLocked || demo || !keyItems.length),
        placeholder: demo ? "Demo key" : !options ? "Loading keys…" : "Select an API key",
      });
      keyPicker.hidden = missingKeys;
      add.hidden = !missingKeys;
      add.disabled = Boolean(keyLocked);
      add.lastElementChild.textContent = `Add ${providerName} Key`;
    },
  };
}
