import type { InspectorBookPage, InspectorChunkDetail, InspectorOverview } from "../../shared/inspectors.js";
import type { World } from "../../shared/types.js";
import { request, worldRoute } from "../data.js";
import { booksView, chunkReader } from "./world-books.js";
import { overviewView } from "./world-overview.js";
import { backControl, button, el, iconControl, muted, notice, readerHeading, replacePanel } from "./ui.js";

type Tab = "overview" | "books";
type View = { root: HTMLElement; update: (overview: InspectorOverview) => void; escape?: () => boolean; close?: () => void };
const tabs: [Tab, string][] = [["overview","Overview"],["books","Books & Chunks"]];

export function createWorldInspector(panel: HTMLElement, worldUpdated: (world: World) => void) {
  const name = panel.querySelector<HTMLElement>(".inspector-world-name")!;
  const sidebar = panel.querySelector<HTMLElement>(".inspector-sidebar")!;
  const main = panel.querySelector<HTMLElement>(".inspector-main")!;
  let controller: AbortController | undefined;
  let timer = 0;
  let worldId = "";
  let data: InspectorOverview | undefined;
  let tab: Tab = "overview";
  let view: View | undefined;
  let sourceLayer: HTMLElement | undefined;
  let sourceVersion = 0;
  let polling = false;
  let sourceTrigger: HTMLElement | SVGElement | undefined;
  let sourceScroll = 0;

  function read<T>(action: string, params: Record<string, string> = {}) {
    return request<T>(`${worldRoute(worldId)}/${action}?${new URLSearchParams(params)}`, undefined, controller?.signal);
  }

  function closeSource(restore = true) {
    sourceVersion++;
    sourceLayer?.remove();
    sourceLayer = undefined;
    if (view) view.root.hidden = false;
    if (restore) {
      sourceTrigger?.focus({ preventScroll: true });
      main.scrollTop = sourceScroll;
    }
    sourceTrigger = undefined;
  }

  function sourceMarker(marker: string, revision: number) {
    const [book, chunk] = marker.slice(1).split(":C").map(Number);
    void showChunk(book, chunk, revision);
  }

  async function showChunk(book: number, chunk: number, revision: number, initial: "extraction" | "text" = "text", direction?: "prev" | "next") {
    const label = `B${book}:C${chunk}`;
    const run = ++sourceVersion;
    if (!sourceLayer) {
      const active = document.activeElement;
      if (active instanceof HTMLElement || active instanceof SVGElement) sourceTrigger = active;
      sourceLayer = el("section", "inspector-source-layer");
      sourceScroll = main.scrollTop;
      if (view) view.root.hidden = true;
      main.append(sourceLayer);
      main.scrollTop = 0;
    }
    const layer = sourceLayer;
    const back = backControl("Back", () => closeSource());
    replacePanel(layer, [readerHeading(label, back), muted("Loading chunk…")]);
    back.focus();
    try {
      const detail = await read<InspectorChunkDetail>("inspector-chunk", {
        book: String(book), chunk: String(chunk), revision: String(revision),
      });
      if (run !== sourceVersion || !controller) return;
      const navigation = el("div", "inspector-controls inspector-chunk-navigation");
      const prev = iconControl("Previous Chunk", "left", () => { void showChunk(book, chunk - 1, revision, initial, "prev"); });
      const next = iconControl("Next Chunk", "right", () => { void showChunk(book, chunk + 1, revision, initial, "next"); });
      const currentBook = data?.world.books.find(item => item.number === book);
      prev.disabled = chunk <= 1;
      next.disabled = !currentBook || revision !== data?.world.book_revision || chunk >= currentBook.total_chunks;
      navigation.append(prev, next);
      replacePanel(layer, [readerHeading(`${detail.book_name} · ${label}`, back, navigation), chunkReader(detail, initial, marker => sourceMarker(marker, revision))]);
      const focus = direction === "prev" ? prev : direction === "next" ? next : back;
      (focus.disabled ? back : focus).focus({ preventScroll: true });
    } catch (error) {
      if (run === sourceVersion && controller) replacePanel(layer, [readerHeading(label, back),
        notice(error, () => { void showChunk(book, chunk, revision, initial); })]);
    }
  }

  async function change(action: "pause" | "resume") {
    const world = await request<World>(`${worldRoute(worldId)}/${action}`, {}, controller?.signal);
    worldUpdated(world);
    await poll();
  }

  function selectTab(next: Tab) {
    tab = next;
    view?.close?.();
    closeSource(false);
    for (const row of sidebar.querySelectorAll<HTMLButtonElement>("button")) row.setAttribute("aria-pressed", String(row.dataset.tab === tab));
    if (tab === "overview") view = overviewView(change);
    else view = booksView(
      (bookId, offset) => read<InspectorBookPage>("inspector-book", { book: bookId, offset: String(offset) }),
      (book, chunk) => {
        if (data) void showChunk(book, chunk, data.world.book_revision, "extraction");
      },
    );
    replacePanel(main, [view.root]);
    if (data) view.update(data);
  }

  async function poll() {
    const session = controller;
    if (!session || polling) return;
    polling = true;
    try {
      const current = await read<InspectorOverview>("inspector");
      if (session !== controller) return;
      data = current;
      name.textContent = current.world.name;
      if (!view?.root.isConnected || !main.contains(view.root)) selectTab(tab);
      else view.update(current);
      main.querySelector(".inspector-poll-error")?.remove();
    } catch (error) {
      if (session !== controller) return;
      const existing = main.querySelector(".inspector-poll-error");
      if (!existing) {
        const message = notice(error, () => { main.querySelector(".inspector-poll-error")?.remove(); void poll(); });
        message.classList.add("inspector-poll-error");
        main.prepend(message);
      }
    } finally {
      if (session === controller) polling = false;
    }
  }

  function close() {
    controller?.abort();
    controller = undefined;
    window.clearInterval(timer);
    view?.close?.();
    view = undefined;
    data = undefined;
    polling = false;
    closeSource(false);
  }

  function open(world: World) {
    close();
    worldId = world.id;
    name.textContent = world.name;
    controller = new AbortController();
    sidebar.replaceChildren(...tabs.map(([id, label]) => {
      const control = button(label, () => selectTab(id), "inspector-nav-row inspector-world-tab");
      control.dataset.tab = id;
      return control;
    }));
    selectTab("overview");
    void poll();
    timer = window.setInterval(() => { void poll(); }, 750);
  }

  return {
    open, close,
    get worldId() { return worldId; },
    escape() {
      if (sourceLayer) { closeSource(); return true; }
      return view?.escape?.() ?? false;
    },
  };
}
