import { editName, element, errorText, iconButton } from "./controls.js";

export const talesPath = worldId => `/worlds/${worldId}/tales`;
const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });

function age(timestamp) {
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - timestamp));
  if (seconds < 60) return "Just now";
  for (const [unit, length] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (seconds >= length) return relativeTime.format(-Math.floor(seconds / length), unit);
  }
}

export function initTaleHub({ request, navigate, confirm, settings, onActivity }) {
  const list = element("tale-list");
  const panel = element("tales-panel");
  const empty = element("tales-empty");
  const add = element("new-tale");
  const settingsButton = element("hub-tale-settings");
  const error = element("tales-error");
  let world;
  let opening;
  let editing;
  let loading;
  let loaded = false;
  let revision = 0;
  let rows = new Map();
  const divider = document.createElement("hr");
  divider.className = "tale-divider";

  async function change(taleId, action, json = {}) {
    await request(`/api${talesPath(world.id)}/${taleId}/${action}`, { method: "POST", json });
  }

  function rowFor(tale) {
    const row = document.createElement("article");
    row.className = "tale-row";
    const pin = iconButton("Pin Tale", "");
    pin.classList.add("tale-pin");
    pin.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16v6M8 3h8a1 1 0 0 1 0 2.5h-.5v5l3 4v1.5h-13V14.5l3-4v-5H8A1 1 0 0 1 8 3Z"/></svg>';
    const text = document.createElement("div");
    text.className = "tale-row-text";
    const line = document.createElement("div");
    line.className = "tale-title-line";
    const link = document.createElement("a");
    link.href = `${talesPath(world.id)}/${tale.id}`;
    const pencil = iconButton("Rename Tale", "✎");
    pencil.classList.add("tale-row-action");
    line.append(link, pencil);
    const preview = document.createElement("p");
    preview.className = "tale-preview";
    text.append(line, preview);
    const metadata = document.createElement("span");
    metadata.className = "tale-row-meta";
    const remove = iconButton("Delete Tale", "×");
    remove.classList.add("tale-row-action");
    row.append(pin, text, metadata, remove);

    const record = { row, pin, link, preview, metadata, tale };
    pin.addEventListener("click", async () => {
      try {
        await change(tale.id, "pin", { pinned: !record.tale.pinned });
        await refresh(true);
      } catch (failure) {
        errorText(error, failure.message);
      }
    });
    pencil.addEventListener("click", () => {
      if (editing) return;
      editing = editName(line, record.tale.title, "Tale title", async title => {
        await change(tale.id, "rename", { title });
        record.tale.title = link.textContent = title;
      }, () => {
        editing = null;
        pencil.focus();
        refresh(true);
      }, message => errorText(error, message));
    });
    remove.addEventListener("click", async () => {
      const openedWorld = world;
      if (!await confirm(`Delete “${record.tale.title}”?`, "This permanently deletes the Tale and its messages.",
        "Cancel", "Delete Tale", true) || world?.id !== openedWorld.id) return;
      try {
        await change(tale.id, "delete");
        await refresh(true);
        add.focus();
      } catch (failure) {
        errorText(error, failure.message);
      }
    });
    return record;
  }

  function render(tales) {
    if (editing) return;
    empty.hidden = tales.length > 0;
    const ids = new Set(tales.map(tale => tale.id));
    for (const [id, record] of rows) {
      if (ids.has(id)) continue;
      record.row.remove();
      rows.delete(id);
    }
    const firstUnpinned = tales.findIndex(tale => !tale.pinned);
    if (firstUnpinned <= 0) divider.remove();
    const children = [];
    tales.forEach((tale, index) => {
      if (index > 0 && index === firstUnpinned) children.push(divider);
      const record = rows.get(tale.id) ?? rowFor(tale);
      rows.set(tale.id, record);
      const { row, pin, link, preview, metadata } = record;
      record.tale = tale;
      row.classList.toggle("pinned", Boolean(tale.pinned));
      pin.title = tale.pinned ? "Unpin Tale" : "Pin Tale";
      pin.setAttribute("aria-label", pin.title);
      pin.setAttribute("aria-pressed", String(Boolean(tale.pinned)));
      if (link.textContent !== tale.title) link.textContent = tale.title;
      let snippet = tale.content;
      if (!tale.message_count) snippet = "No messages yet — start the conversation";
      else if (tale.status === "generating" && tale.has_thinking && !snippet) snippet = "Thinking…";
      const user = tale.role === "user";
      const previewText = user ? `User: ${snippet}` : snippet;
      if (preview.textContent !== previewText) {
        preview.textContent = snippet;
        if (user) {
          const label = document.createElement("strong");
          label.textContent = "User: ";
          preview.prepend(label);
        }
      }
      metadata.textContent = tale.message_count
        ? `${tale.message_count} ${tale.message_count === 1 ? "msg" : "msgs"} · ${age(tale.last_activity_at ?? tale.created_at)}`
        : "New";
      children.push(row);
    });
    children.forEach((child, index) => {
      if (list.children[index] !== child) list.insertBefore(child, list.children[index] ?? null);
    });
  }

  async function refresh(force = false) {
    if (!world || panel.hidden || editing || (loading && !force)) return;
    const id = world.id;
    const token = ++revision;
    loading = token;
    try {
      const tales = await request(`/api${talesPath(id)}`);
      if (token === revision) {
        loaded = true;
        render(tales);
      }
    } catch (failure) {
      if (token === revision && !loaded) errorText(error, failure.message);
    } finally {
      if (loading === token) loading = null;
    }
  }

  async function openTale(current, resume) {
    if (!current || current.status !== "ready" || opening) return;
    const operation = opening = {};
    add.disabled = true;
    errorText(error);
    try {
      const path = talesPath(current.id);
      const tale = await request(`/api${path}${resume ? "/play" : ""}`, { method: "POST", json: {} });
      onActivity();
      if (opening === operation && world?.id === current.id) navigate(`${path}/${tale.id}`);
    } catch (failure) {
      if (opening === operation && world?.id === current.id) errorText(error, failure.message);
    } finally {
      if (opening === operation) {
        opening = null;
        add.disabled = world?.status !== "ready";
      }
    }
  }

  add.addEventListener("click", () => openTale(world, false));
  settingsButton.addEventListener("click", () => settings.open(settingsButton));
  element("tales-tab").addEventListener("click", () => queueMicrotask(() => refresh()));

  return {
    play: current => openTale(current, true),
    show(current) {
      if (world?.id !== current?.id) {
        revision++;
        rows = new Map();
        list.replaceChildren();
        loading = editing = opening = null;
        loaded = false;
        empty.hidden = true;
        errorText(error);
      }
      world = current;
      add.disabled = current?.status !== "ready" || Boolean(opening);
      refresh();
    },
  };
}
