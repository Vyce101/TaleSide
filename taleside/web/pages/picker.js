function sameSelection(first, second) {
  return first?.length === second.length && second.every((id, index) => id === first[index]);
}

export function initPicker(id, labelId, onChange, { multiple = false, scrollContainer } = {}) {
  const picker = document.getElementById(id);
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "picker-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", `${id}-menu`);
  trigger.setAttribute("aria-labelledby", `${labelId} ${id}-value`);
  trigger.innerHTML = `<span id="${id}-value"></span>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
  const label = trigger.firstElementChild;
  const menu = document.createElement("div");
  menu.id = `${id}-menu`;
  menu.className = "picker-menu";
  menu.hidden = true;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-labelledby", labelId);
  if (multiple) menu.setAttribute("aria-multiselectable", "true");
  picker.append(trigger, menu);
  let options = [];
  let value;
  let pendingSelection;
  let placeholder;
  let renderedGroups;

  function renderSelection() {
    const selected = multiple ? (pendingSelection ?? value) : [value];
    for (const option of options) option.setAttribute("aria-selected", String(selected.includes(option.value)));
    label.textContent = selected.length > 1 ? `${selected.length} keys selected`
      : options.find(option => option.value === selected[0])?.textContent ?? placeholder;
  }

  function close(restoreFocus = false, commit = true) {
    if (menu.hidden) return;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus();
    menu.hidden = true;
    if (!multiple) return;
    const selected = pendingSelection;
    pendingSelection = null;
    const changed = commit && !sameSelection(value, selected);
    if (changed) value = selected;
    renderSelection();
    if (changed) onChange(selected);
  }

  function open(position = 0) {
    if (trigger.disabled || trigger.hasAttribute("aria-disabled") || !options.length) return;
    if (multiple) pendingSelection = [...value];
    menu.hidden = false;
    const bounds = trigger.getBoundingClientRect();
    const container = scrollContainer?.getBoundingClientRect();
    const spaceBelow = (container?.bottom ?? window.innerHeight) - bounds.bottom;
    const spaceAbove = bounds.top - (container?.top ?? 0);
    menu.style.removeProperty("max-height");
    const above = spaceBelow < menu.offsetHeight + 12 && spaceAbove > spaceBelow;
    menu.toggleAttribute("data-above", above);
    if (container) menu.style.maxHeight = `min(300px, 55dvh, ${Math.max(0, (above ? spaceAbove : spaceBelow) - 8)}px)`;
    trigger.setAttribute("aria-expanded", "true");
    const selected = options.find(option => multiple ? value.includes(option.value) : option.value === value);
    (selected ?? options.at(position)).focus();
  }

  trigger.addEventListener("click", () => menu.hidden ? open() : close(true));
  picker.addEventListener("focusout", event => {
    if (!picker.contains(event.relatedTarget)) close();
  });
  document.addEventListener("pointerdown", event => {
    if (!picker.contains(event.target)) close();
  });
  picker.addEventListener("keydown", event => {
    const { key } = event;
    if (menu.hidden) {
      if (key !== "ArrowDown" && key !== "ArrowUp") return;
      event.preventDefault();
      open(key === "ArrowDown" ? 0 : -1);
      return;
    }
    if (key === "Escape" || key === "Tab") {
      if (key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      close(true);
      return;
    }
    const index = options.indexOf(document.activeElement);
    const positions = {
      ArrowDown: Math.min(index + 1, options.length - 1),
      ArrowUp: Math.max(index - 1, 0),
      Home: 0,
      End: options.length - 1,
    };
    if (!Object.hasOwn(positions, key)) return;
    event.preventDefault();
    options[positions[key]].focus();
  });
  menu.addEventListener("click", event => {
    const option = event.target.closest("button");
    if (!option) return;
    if (multiple) {
      pendingSelection = pendingSelection.includes(option.value)
        ? pendingSelection.filter(id => id !== option.value)
        : [...pendingSelection, option.value];
      renderSelection();
      return;
    }
    close(true);
    if (option.value !== value) onChange(option.value);
  });

  return {
    close,
    focus: () => trigger.focus(),
    update(groups, selected, { disabled = false, saving = false, placeholder: emptyLabel = "" } = {}) {
      const groupSignature = JSON.stringify(groups);
      if (groupSignature !== renderedGroups) {
        close(menu.contains(document.activeElement), false);
        menu.replaceChildren();
        options = [];
        for (const { name, hint, divider, items } of groups) {
          const group = document.createElement("div");
          if (name) {
            group.setAttribute("role", "group");
            group.setAttribute("aria-label", name);
            const heading = document.createElement("div");
            heading.className = "picker-heading";
            heading.setAttribute("aria-hidden", "true");
            const title = document.createElement("span");
            title.textContent = name;
            heading.append(title);
            if (hint) {
              const info = document.createElement("span");
              info.className = "picker-hint";
              info.textContent = hint;
              heading.append(info);
            }
            group.append(heading);
          }
          group.classList.toggle("picker-divider", Boolean(divider));
          for (const item of items) {
            const option = document.createElement("button");
            option.type = "button";
            option.setAttribute("role", "option");
            option.tabIndex = -1;
            option.value = item.id;
            option.textContent = item.label;
            group.append(option);
            options.push(option);
          }
          menu.append(group);
        }
        renderedGroups = groupSignature;
      }
      if (multiple && !sameSelection(value, selected)) close(menu.contains(document.activeElement), false);
      if (disabled || saving) close(false, false);
      value = selected;
      placeholder = emptyLabel;
      renderSelection();
      if (saving) trigger.setAttribute("aria-disabled", "true");
      else trigger.removeAttribute("aria-disabled");
      trigger.disabled = disabled;
    },
  };
}
