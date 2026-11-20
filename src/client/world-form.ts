import type { Book, World } from "../shared/types.js";
import { element } from "./dom.js";
import { avatar, escapeHtml, icon, iconButton, worldIndexStatus } from "./view.js";

export type EditableBook = Book & { file?: File };
export const processing = (world?: World) => world?.status === "creating" || world?.status === "pausing";

export function editorMarkup(world: World | undefined, indexingOpen: boolean | undefined) {
  const options = { chunkSize: world?.max_chunk_size ?? 8000, boundarySearch: world?.boundary_search_distance ?? 1000 };
  return `<form id="world-editor" autocomplete="off">
    <div class="world-editor-actions">
      ${iconButton("world-list", "back", "Back to Worlds", 'id="world-list-button"')}
      <div class="world-index-actions" aria-label="Indexing actions" role="group">
        <button type="submit" class="icon-button" id="world-index-action"></button>
      </div>
    </div>
    <div class="world-identity">
      <label class="world-art-picker" for="world-art-input" data-tooltip="Change World artwork">
        <span id="world-editor-art">${avatar(world)}</span>
      </label>
      <input id="world-art-input" type="file" accept="image/*" class="offscreen-input" aria-label="World artwork" >
      <div>
        <label class="world-name-label" for="world-name-input">World name
          <input id="world-name-input" name="worldTitle" type="text" autocomplete="off" placeholder="Name this World" value="${escapeHtml(world?.name ?? "")}" maxlength="100" required >
        </label>
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
        <input type="number" id="world-chunk-size" name="chunkSize" value="${options.chunkSize}" min="1" required>
        <label for="world-boundary">Boundary search (characters)</label>
        <input type="number" id="world-boundary" name="boundarySearch" value="${options.boundarySearch}" min="0" aria-describedby="index-boundary-warning" required>
        <small id="index-boundary-warning" hidden>Boundary search covers the entire chunk. This can create many short chunks and slow indexing.</small>
      </fieldset>
    </details>
    <p id="world-error" class="inline-error" role="alert" hidden></p>
  </form>`;
}

export function showBoundaryWarning() {
  const size = element<HTMLInputElement>("world-chunk-size").valueAsNumber;
  const boundary = element<HTMLInputElement>("world-boundary").valueAsNumber;
  element("index-boundary-warning").hidden = !(size > 0 && boundary >= size);
}

export function renderIndex(world: World | undefined, books: EditableBook[], busy: boolean) {
  const status = world?.status;
  const [glyph, label] = status === "creating" || status === "pausing" ? ["pause", "Pause indexing"] as const
    : status === "paused" || status === "failed" ? ["play", "Resume indexing"] as const
    : world ? ["play", "Start indexing"] as const : ["check", "Create World"] as const;
  const action = element<HTMLButtonElement>("world-index-action");
  const clear = element<HTMLButtonElement>("clear-world-index");
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
  for (const id of ["world-chunk-size", "world-boundary"]) element<HTMLInputElement>(id).readOnly = Boolean(locked || busy);
  showBoundaryWarning();
}

export function upload(settings: object, books: EditableBook[], picture?: File) {
  const body = new FormData();
  body.append("settings", JSON.stringify({ ...settings, books: books.map(({ filename, name }) => ({ filename, name })) }));
  for (const book of books) if (book.file) body.append("book", book.file);
  if (picture) body.append("artwork", picture);
  return body;
}
