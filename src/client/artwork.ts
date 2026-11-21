import { element } from "./dom.js";

type Crop = { x: number; y: number; size: number };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export async function cropArtwork(file: File, subject = "World"): Promise<File | undefined> {
  const signature = new TextDecoder().decode(await file.slice(0, 6).arrayBuffer());
  if (file.type === "image/gif" || /\.gif$/i.test(file.name) || /^GIF8[79]a$/.test(signature)) {
    throw new Error("Choose an image other than GIF.");
  }
  const dialog = element<HTMLDialogElement>("artwork-dialog");
  const image = element<HTMLImageElement>("crop-image");
  element("crop-title").textContent = `Crop ${subject} picture`;
  image.alt = `Selected ${subject} picture`;
  const box = element("crop-box");
  const save = element<HTMLButtonElement>("crop-save");
  const url = URL.createObjectURL(file);
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  try {
    image.src = url;
    try { await image.decode(); }
    catch { throw new Error("This image could not be opened."); }
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    const size = Math.min(width, height);
    const crop: Crop = { size, x: (width - size) / 2, y: (height - size) / 2 };
    const scale = () => image.getBoundingClientRect().width / width;
    let drag: { id: number; x: number; y: number; start: Crop; corner?: string } | undefined;
    let cropped: File | undefined;
    let failure: unknown;

    function render() {
      box.style.left = `${crop.x / width * 100}%`;
      box.style.top = `${crop.y / height * 100}%`;
      box.style.width = `${crop.size / width * 100}%`;
      box.style.height = `${crop.size / height * 100}%`;
    }

    function move(start: Crop, dx: number, dy: number, corner?: string) {
      if (!corner) {
        crop.x = clamp(start.x + dx, 0, width - start.size);
        crop.y = clamp(start.y + dy, 0, height - start.size);
      } else {
        const west = corner.endsWith("w");
        const north = corner.startsWith("n");
        const anchorX = start.x + (west ? start.size : 0);
        const anchorY = start.y + (north ? start.size : 0);
        const max = Math.min(west ? anchorX : width - anchorX, north ? anchorY : height - anchorY);
        const min = Math.min(48 / scale(), max);
        const outward = ((west ? -dx : dx) + (north ? -dy : dy)) / 2;
        crop.size = clamp(start.size + outward, min, max);
        crop.x = west ? anchorX - crop.size : anchorX;
        crop.y = north ? anchorY - crop.size : anchorY;
      }
      render();
    }

    box.addEventListener("pointerdown", event => {
      if (event.button !== 0 || drag) return;
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-corner]");
      box.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: { ...crop }, corner: target?.dataset.corner };
    }, options);
    box.addEventListener("pointermove", event => {
      if (drag?.id === event.pointerId) {
        move(drag.start, (event.clientX - drag.x) / scale(), (event.clientY - drag.y) / scale(), drag.corner);
      }
    }, options);
    box.addEventListener("lostpointercapture", () => { drag = undefined; }, options);
    box.addEventListener("keydown", event => {
      const step = (event.shiftKey ? 12 : 2) / scale();
      const directions: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
      };
      const delta = directions[event.key];
      if (!delta) return;
      event.preventDefault();
      move({ ...crop }, ...delta, (event.target as HTMLElement).dataset.corner);
    }, options);

    dialog.addEventListener("submit", async event => {
      if ((event as SubmitEvent).submitter !== save) return;
      event.preventDefault();
      if (save.disabled) return;
      save.disabled = true;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = Math.max(1, Math.min(512, Math.floor(crop.size)));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("This browser could not crop the image.");
        context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/webp", 0.87));
        if (!blob) throw new Error("This browser could not save the cropped image.");
        cropped = new File([blob], blob.type === "image/webp" ? "world.webp" : "world.png", { type: blob.type });
      } catch (error) { failure = error; }
      if (!listeners.signal.aborted && dialog.open) dialog.close("save");
    }, options);

    dialog.returnValue = "";
    render();
    await new Promise<void>(resolve => {
      dialog.showModal();
      dialog.addEventListener("close", () => resolve(), { once: true });
    });
    if (dialog.returnValue !== "save") return;
    if (failure) throw failure;
    return cropped;
  } finally {
    save.disabled = false;
    listeners.abort();
    image.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}
