import type { Book, World } from "../shared/types.js";
import { element } from "./dom.js";
import { avatar, escapeHtml, icon, iconButton, worldIndexStatus } from "./view.js";

export type EditableBook = Book & { file?: File };
export const processing = (world?: World) => world?.status === "creating" || world?.status === "pausing";

export function editorMarkup(world: World | undefined, indexingOpen: boolean | undefined) {
  const chunkSize = world?.max_chunk_size ?? 8000;
  return `<form id="world-editor" autocomplete="off">
    <div class="world-editor-actions">
      ${iconButton("world-list", "back", "Back to Worlds", 'id="world-list-button"')}
      <div class="world-index-actions" aria-label="Indexing actions" role="group">
        <button type="submit" class="icon-button" id="world-index-action"></button>
        ${iconButton("discard-world", "deleteWorld", "Delete World", 'id="discard-world"')}
      </div>
    </div>
    <div class="world-identity">
      <label class="world-art-picker" for="world-art-input" data-tooltip="Change World artwork">
        <span id="world-editor-art">${avatar(world ?? { artwork: null })}</span>
      </label>
      <input id="world-art-input" type="file" accept="image/*" class="offscreen-input" aria-label="World artwork" >
      <div>
        <label class="world-name-label" for="world-name-input">World name
          <input id="world-name-input" name="worldTitle" type="text" autocomplete="off" placeholder="Name this World" value="${escapeHtml(world?.name ?? "")}" maxlength="100" required >
        </label>
        <div class="world-index-progress" ${world ? "" : "hidden"}>
          <progress id="world-index-progress" max="100" aria-label="World indexing progress" hidden></progress>
          <span id="world-index-status"></span>
        </div>
      </div>
    </div>
    <details class="index-settings" ${indexingOpen ? "open" : ""}>
      <summary>Indexing<span id="index-lock" class="index-lock" hidden>${icon("lock")}Locked</span></summary>
      <fieldset >
        <label for="world-model">Embedding model</label>
        <select id="world-model" name="model"></select>
        <label for="world-key-toggle">Embedding key</label>
        <div id="world-key"></div>
        <label for="world-chunk-size">Chunk size (characters)</label>
        <input type="number" id="world-chunk-size" name="chunkSize" value="${chunkSize}" min="1" required>
      </fieldset>
    </details>
    <details id="world-progress" class="index-settings" ${world ? "" : "hidden"}>
      <summary>World progress</summary>
      <div class="world-progress-body">
        <p id="world-progress-total"></p>
        <ul id="world-progress-books"></ul>
      </div>
    </details>
    <label for="world-description">World description</label>
    <textarea id="world-description" rows="4"></textarea>
    <div class="opening-heading">
      <label for="world-opening">First Message</label>
      <div id="opening-controls"></div>
    </div>
    <textarea id="world-opening" rows="6"></textarea>
    <div class="books-heading">
      <h3>Books</h3>
      <div class="book-heading-actions">
        <div id="book-upload"><input type="file" id="world-books-input" class="offscreen-input" accept=".txt,.md,.markdown,.html,.htm,.epub" multiple aria-label="Add books">${iconButton("add-world-books", "plus", "Add books", 'id="add-world-books"')}</div>
        ${iconButton("clear-index", "delete", "Delete indexing", 'id="clear-world-index"')}
      </div>
    </div>
    <ul id="world-books" class="book-list"></ul>
    <p id="world-error" class="inline-error" role="alert" hidden></p>
  </form>`;
}

export function renderBooks(books: EditableBook[], world: World | undefined) {
  const list = element<HTMLUListElement>("world-books");
  if (!books.length) {
    if (!list.querySelector(".empty-copy")) list.innerHTML = '<li class="empty-copy">Add a book to get started.</li>';
    return;
  }
  list.querySelector(".empty-copy")?.remove();
  const rows = new Map([...list.querySelectorAll<HTMLLIElement>("[data-book-id]")].map(row => [row.dataset.bookId, row]));
  books.forEach((book, index) => {
    let row = rows.get(book.id);
    if (!row) {
      row = document.createElement("li");
      row.dataset.bookId = book.id;
      const id = `data-id="${book.id}"`;
      row.innerHTML = `<div class="book-info"><strong></strong><small></small></div>
        <div class="tale-row-actions">
          ${iconButton("book-up", "down", "Move book up", id)}
          ${iconButton("book-down", "down", "Move book down", id)}
          ${iconButton("rename-book", "rename", "Rename book", id)}
          ${iconButton("remove-book", "delete", "Remove book", id)}
        </div>`;
    }
    rows.delete(book.id);
    const [name, filename] = row.querySelector(".book-info")!.children as HTMLCollectionOf<HTMLElement>;
    if (name.textContent !== book.name) name.textContent = book.name;
    if (filename.textContent !== book.filename) filename.textContent = filename.dataset.tooltip = book.filename;
    row.querySelector<HTMLElement>(".tale-row-actions")!.hidden = processing(world);
    row.querySelector<HTMLButtonElement>('[data-action="book-up"]')!.disabled = index === 0;
    row.querySelector<HTMLButtonElement>('[data-action="book-down"]')!.disabled = index === books.length - 1;
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
  });
  for (const row of rows.values()) row.remove();
}

export function renderWorldProgress(world?: World) {
  if (!world || !element<HTMLDetailsElement>("world-progress").open) return;
  const count = (done: number, total: number) => `${done.toLocaleString()} of ${total.toLocaleString()} chunks indexed`;
  element("world-progress-total").textContent = count(world.embedded_chunks, world.total_chunks);
  const books = element("world-progress-books");
  books.innerHTML = world.books.length ? world.books.map(book => `<li>
    <strong>${escapeHtml(book.name)}</strong>
    <progress max="${book.total_chunks || 1}" value="${book.embedded_chunks}" aria-label="${escapeHtml(book.name)} indexing progress"></progress>
    <small>${count(book.embedded_chunks, book.total_chunks)}</small>
  </li>`).join("") : '<li>No books in this World.</li>';
}

export function renderIndex(world: World | undefined, books: EditableBook[], busy: boolean) {
  const status = world?.status;
  const [glyph, label] = status === "creating" || status === "pausing" ? ["pause", "Pause indexing"] as const
    : status === "paused" || status === "failed" ? ["play", "Resume indexing"] as const
    : world ? ["play", "Start indexing"] as const : ["check", "Create World"] as const;
  const action = element<HTMLButtonElement>("world-index-action");
  const clear = element<HTMLButtonElement>("clear-world-index");
  const discard = element<HTMLButtonElement>("discard-world");
  discard.hidden = !world;
  discard.disabled = busy;
  action.type = status && status !== "unindexed" ? "button" : "submit";
  action.hidden = status === "ready";
  action.disabled = busy || status === "pausing" || (status === "unindexed" && !books.length);
  clear.hidden = !world || status === "unindexed";
  clear.disabled = busy || processing(world);
  if (action.hidden && document.activeElement === action) clear.focus({ preventScroll: true });
  if (action.dataset.tooltip !== label) {
    action.dataset.tooltip = label;
    action.setAttribute("aria-label", label);
    action.innerHTML = icon(glyph);
  }
  const locked = world && status !== "unindexed";
  element("index-lock").hidden = !locked;
  element<HTMLSelectElement>("world-model").disabled = Boolean(locked || busy);
  element<HTMLInputElement>("world-chunk-size").readOnly = Boolean(locked || busy);
  element("book-upload").hidden = processing(world);
  element<HTMLButtonElement>("add-world-books").disabled = busy;
  element<HTMLInputElement>("world-books-input").disabled = processing(world) || busy;
  if (world) {
    element("world-index-status").textContent = worldIndexStatus(world);
    const progress = element<HTMLProgressElement>("world-index-progress");
    progress.hidden = !["creating", "pausing", "paused", "failed"].includes(world.status);
    progress.value = world.progress;
    renderWorldProgress(world);
  }
  renderBooks(books, world);
}

export function upload(settings: object, books: EditableBook[], picture?: File) {
  const body = new FormData();
  body.append("settings", JSON.stringify({ ...settings, books: books.map(({ filename, name }) => ({ filename, name })) }));
  for (const book of books) if (book.file) body.append("book", book.file);
  if (picture) body.append("artwork", picture);
  return body;
}
