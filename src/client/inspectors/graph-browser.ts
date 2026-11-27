import { ENTITY_TYPES } from "../../shared/extraction.js";
import type { createGraphMap } from "./graph-map.js";
import { button, count, el, iconControl, muted, patchList, search } from "./ui.js";

type GraphRecord = {
  id: string; name: string; type: string | null; source_notes?: number; group?: string; status?: string; text?: string;
};

const filterOptions = [
  ["entity", ""], ["relationship", null],
  ...ENTITY_TYPES.map(type => [type.toLowerCase(), type] as const),
] as const;
const commands = new Map<string, string | null>([
  ...filterOptions, ["faction", "FACTION/GROUP"], ["group", "FACTION/GROUP"], ["rule", "SYSTEM_OR_WORLD_RULE"],
]);
const pageSize = 60;
let filterMenuSequence = 0;

function matchingRecords(records: GraphRecord[], input: string) {
  const value = input.trim().toLowerCase();
  const command = /^\/(\S+)(?:\s+|$)/.exec(value);
  const type = command ? commands.get(command[1]) : undefined;
  if (command && type === undefined) {
    return value === command[0] && filterOptions.some(([option]) => option.startsWith(command[1])) ? records : [];
  }
  const query = command ? value.slice(command[0].length) : value === "/" ? "" : value;
  return records.filter(record => {
    if (type !== undefined && (type === "" ? record.type === null : record.type !== type)) return false;
    return !query || [record.name, record.type ?? "relationship", record.group, record.text]
      .some(text => text?.toLowerCase().includes(query));
  });
}

export function graphBrowser(open: (id: string) => void) {
  const root = el("div", "inspector-list inspector-graph-browser");
  const details = el("div", "inspector-graph-details");
  const list = el("div", "inspector-list");
  const message = muted("");
  let records: GraphRecord[] = [];
  let searchable: GraphRecord[] = [];
  let limit = pageSize;
  function searchChanged() { limit = pageSize; render(); }
  const input = search("Search Graph", "", searchChanged);
  const form = el("form", "inspector-map-search");
  const field = el("div", "inspector-graph-filter-field");
  const menu = graphFilterMenu(input, searchChanged);
  const hint = muted("Type / to filter by record type.");
  hint.id = `${menu.root.id}-hint`;
  input.setAttribute("aria-describedby", hint.id);
  field.append(input, menu.root);
  form.append(field, hint);
  form.addEventListener("submit", event => {
    event.preventDefault();
    list.querySelector<HTMLButtonElement>("button")?.click();
  });
  const more = button("Show More Records", () => { limit += pageSize; render(); });
  root.append(form, details, list, message, more);
  render();

  function render() {
    const matches = input.value.trim() ? matchingRecords(searchable, input.value) : records;
    const rows: ({ key: string; title: string } | { key: string; item: GraphRecord })[] = [];
    let group: string | undefined;
    for (const item of matches.slice(0, limit)) {
      if (item.group && item.group !== group) {
        group = item.group;
        rows.push({ key: `group:${group}`, title: group });
      }
      rows.push({ key: `record:${item.id}`, item });
    }
    patchList(list, rows, row => row.key, row => {
      if ("title" in row) return el("h4", "", row.title);
      const control = button("", () => open(row.item.id), "inspector-graph-row");
      const label = el("span", "inspector-graph-row-label");
      label.append(el("strong"), el("small", "inspector-muted"));
      const arrow = el("span", "inspector-muted", "›");
      arrow.setAttribute("aria-hidden", "true");
      control.append(label, arrow);
      updateRow(control, row.item);
      return control;
    }, (node, row) => { if ("item" in row) updateRow(node, row.item); });
    message.hidden = Boolean(matches.length);
    message.textContent = input.value.trim() ? "No matching graph records." : "No graph records yet.";
    more.hidden = matches.length <= limit;
  }

  function updateRow(control: HTMLElement, item: GraphRecord) {
    const notes = item.source_notes === undefined ? "" :
      `${count(item.source_notes)} ${item.source_notes === 1 ? "source note" : "source notes"}`;
    const label = control.children[0];
    label.children[0].textContent = item.name;
    label.children[1].textContent = [item.type ?? "Relationship", notes, item.status].filter(Boolean).join(" · ");
    control.dataset.kind = item.type ? "entity" : "relationship";
  }

  return {
    root, details,
    update(items: GraphRecord[], searchOnly: GraphRecord[] = []) {
      records = items;
      searchable = [...items, ...searchOnly];
      menu.update(searchable);
      render();
    },
  };
}

function graphFilterMenu(input: HTMLInputElement, apply: () => void) {
  const root = el("div", "inspector-graph-filter-menu");
  root.id = `inspector-graph-filters-${++filterMenuSequence}`;
  root.hidden = true;
  root.setAttribute("role", "listbox");
  root.setAttribute("aria-label", "Graph Type Filters");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", root.id);
  input.setAttribute("aria-expanded", "false");
  const totals = new Map<string | null, number>();
  let options: (typeof filterOptions)[number][] = [];
  let active = -1;

  function hide() {
    root.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function highlight(index: number) {
    active = index;
    for (const [offset, option] of [...root.children].entries()) {
      option.setAttribute("aria-selected", String(offset === index));
    }
    if (index < 0) input.removeAttribute("aria-activedescendant");
    else input.setAttribute("aria-activedescendant", root.children[index].id);
  }

  function select(index: number) {
    const command = options[index]?.[0];
    if (!command) return;
    input.value = `/${command} `;
    hide();
    apply();
  }

  function show(preserveSelection = false) {
    const value = /^\/([^\s]*)$/.exec(input.value.trimStart().toLowerCase());
    if (!value) { hide(); return; }
    const previous = preserveSelection ? options[active]?.[0] : undefined;
    options = filterOptions.filter(([command]) => command.startsWith(value[1]));
    if (!options.length) { hide(); return; }
    root.replaceChildren(...options.map(([command, type], index) => {
      const option = button("", () => select(index), "inspector-graph-filter-option");
      option.id = `${root.id}-${command}`;
      option.tabIndex = -1;
      option.setAttribute("role", "option");
      option.append(el("span", "", `/${command}`), el("small", "inspector-muted", count(totals.get(type) ?? 0)));
      option.addEventListener("pointerdown", event => event.preventDefault());
      return option;
    }));
    root.hidden = false;
    input.setAttribute("aria-expanded", "true");
    highlight(options.findIndex(([command]) => command === previous));
  }

  input.addEventListener("input", () => show());
  input.addEventListener("focus", () => show());
  input.addEventListener("blur", hide);
  input.addEventListener("keydown", event => {
    if (root.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      hide();
    } else if (event.key === "Enter") {
      event.preventDefault();
      select(Math.max(0, active));
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = active < 0 ? (event.key === "ArrowDown" ? 0 : options.length - 1)
        : (active + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length;
      highlight(next);
      root.children[next].scrollIntoView({ block: "nearest" });
    }
  });

  return {
    root,
    update(records: GraphRecord[]) {
      totals.clear();
      for (const { type } of records) {
        totals.set(type, (totals.get(type) ?? 0) + 1);
        if (type !== null) totals.set("", (totals.get("") ?? 0) + 1);
      }
      if (!root.hidden) show(true);
    },
  };
}

export function revealGraphDetail(heading: HTMLElement) {
  const pane = heading.closest<HTMLElement>(".inspector-main");
  if (!pane || !heading.getClientRects().length) return;
  const viewportTop = pane.getBoundingClientRect().top + pane.clientTop;
  const { top, bottom } = heading.getBoundingClientRect();
  if (top < viewportTop) pane.scrollTop += top - viewportTop;
  else if (bottom > viewportTop + pane.clientHeight) return;
  heading.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
}

export function graphConnections(map: ReturnType<typeof createGraphMap>) {
  const root = el("section", "inspector-graph-connected");
  const title = el("strong");
  const rows = el("div", "inspector-list");
  root.append(title, rows);
  return {
    root,
    update(id: string, relationship: boolean) {
      const items = map.connections(id);
      root.hidden = !items.length;
      title.textContent = relationship ? "Connected Nodes" : "Relationships";
      patchList(rows, [...items], item => item.id, item => {
        const row = el("div", "inspector-graph-connection-row");
        row.append(button(item.name, () => map.focus(item.id), "inspector-graph-connection"));
        if ("neighbor" in item) {
          const neighbor = item.neighbor;
          row.append(iconControl(`View Connected Entity: ${neighbor.name}`, "branch", () => map.focus(neighbor.id)));
        }
        return row;
      });
    },
  };
}
