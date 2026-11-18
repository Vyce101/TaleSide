export function initPicker(id, labelId, onChange) {
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
  picker.append(trigger, menu);
  let options = [];
  let value;
  let renderedGroups;

  function close(restoreFocus = false) {
    if (menu.hidden) return;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus();
    menu.hidden = true;
  }

  function open(position = 0) {
    if (trigger.disabled || !options.length) return;
    menu.hidden = false;
    const bounds = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - bounds.bottom;
    menu.toggleAttribute("data-above", spaceBelow < menu.offsetHeight + 12 && bounds.top > spaceBelow);
    trigger.setAttribute("aria-expanded", "true");
    const selected = options.find(option => option.value === value);
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
    close(true);
    if (option.value !== value) onChange(option.value);
  });

  return {
    close,
    focus: () => trigger.focus(),
    update(groups, selected, { disabled = false, placeholder = "" } = {}) {
      const groupSignature = JSON.stringify(groups);
      if (groupSignature !== renderedGroups) {
        close(menu.contains(document.activeElement));
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
      value = selected;
      for (const option of options) option.setAttribute("aria-selected", String(option.value === value));
      label.textContent = options.find(option => option.value === value)?.textContent ?? placeholder;
      if (disabled) close();
      trigger.disabled = disabled;
    },
  };
}
