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
    <p id="world-error" class="inline-error" role="alert" hidden></p>
  </form>`;
}

export function upload(settings: object, books: EditableBook[], picture?: File) {
  const body = new FormData();
  body.append("settings", JSON.stringify({ ...settings, books: books.map(({ filename, name }) => ({ filename, name })) }));
  for (const book of books) if (book.file) body.append("book", book.file);
  if (picture) body.append("artwork", picture);
  return body;
}
