import { RequestError } from "./validation.js";

export type Artwork = { content_type: string; image: Uint8Array };

const MAX_ARTWORK_BYTES = 16 * 1024 * 1024;
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml",
  "image/x-icon", "image/vnd.microsoft.icon", "image/bmp"]);

export async function readArtwork(file: FormDataEntryValue | null): Promise<Artwork | undefined> {
  if (file === null) return;
  if (typeof file === "string" || !imageTypes.has(file.type) || !file.size || file.size > MAX_ARTWORK_BYTES) {
    throw new RequestError("Choose a supported World image up to 16 MB.");
  }
  return { content_type: file.type, image: new Uint8Array(await file.arrayBuffer()) };
}
