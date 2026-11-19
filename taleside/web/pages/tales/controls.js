export const element = id => document.getElementById(id);

export function errorText(node, message = "") {
  node.textContent = message;
  node.hidden = !message;
}

export function fillSelect(select, options, value, placeholder) {
  const markup = JSON.stringify([options, placeholder]);
  if (select.dataset.options !== markup) {
    select.replaceChildren(new Option(placeholder, ""),
      ...options.map(({ id, name }) => new Option(name, id)));
    select.dataset.options = markup;
  }
  if (select.value !== (value ?? "")) select.value = value ?? "";
}

export function iconButton(label, icon) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = icon;
  return button;
}

export function editName(line, initialName, label, onSave, onClose, onError) {
  const form = document.createElement("form");
  form.className = "tale-name-edit";
  const input = document.createElement("input");
  input.value = initialName;
  input.required = true;
  input.autocomplete = "off";
  input.setAttribute("aria-label", label);
  const save = iconButton("Save", "✓");
  save.type = "submit";
  const cancel = iconButton("Cancel", "×");
  form.append(input, save, cancel);
  line.after(form);
  line.hidden = true;
  input.focus();
  input.select();

  function close() {
    form.remove();
    line.hidden = false;
    onClose();
  }
  cancel.addEventListener("click", close);
  form.addEventListener("keydown", event => {
    if (event.key === "Escape" && !save.disabled) {
      event.preventDefault();
      close();
    }
  });
  input.addEventListener("input", () => input.setCustomValidity(""));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (save.disabled) return;
    const name = input.value.trim();
    if (!name) {
      input.setCustomValidity(`Enter a ${label.toLowerCase()}.`);
      input.reportValidity();
      return;
    }
    input.disabled = save.disabled = cancel.disabled = true;
    try {
      await onSave(name);
      close();
    } catch (error) {
      onError(error.message);
      input.disabled = save.disabled = cancel.disabled = false;
      input.focus();
    }
  });
  return form;
}
