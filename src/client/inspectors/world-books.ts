import type { ChunkStatus, InspectorBookPage, InspectorChunkRow, InspectorChunkDetail, InspectorOverview } from "../../shared/inspectors.js";
import type { Book } from "../../shared/types.js";
import { icon } from "../view.js";
import { backControl, button, count, el, heading, muted, notice, patchList, reader, readerHeading, setMeter } from "./ui.js";

type LoadBookPage = (bookId: string, offset: number) => Promise<InspectorBookPage>;

function percent(book: Book, graph: boolean) {
  if (!book.total_chunks) return 0;
  const completed = graph ? (20 * book.embedded_chunks + 50 * book.extracted_chunks) / 70 : book.embedded_chunks;
  return Math.floor(100 * completed / book.total_chunks);
}

export function chunkReader(chunk: InspectorChunkDetail, initial: "extraction" | "text", onSource?: (marker: string) => void) {
  const root = el("div", "inspector-list");
  const body = el("div", "inspector-list");
  const totals = chunk.passes.flatMap(pass => pass.records);
  const entities = totals.filter(item => item.kind === "entity").length;
  const tabs = el("div", "inspector-reader-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Chunk View");
  body.id = "inspector-chunk-content";
  body.setAttribute("role", "tabpanel");
  const textTab = button("Text", () => chooseView(textTab), "inspector-reader-tab");
  const extractionTab = button("Extraction", () => chooseView(extractionTab), "inspector-reader-tab");
  for (const [tab, name] of [[extractionTab, "extraction"], [textTab, "text"]] as const) {
    tab.id = `inspector-chunk-${name}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", body.id);
    tabs.append(tab);
  }
  tabs.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tab = event.key === "Home" ? extractionTab : event.key === "End" ? textTab
      : event.target === textTab ? extractionTab : textTab;
    chooseView(tab);
    tab.focus();
  });

  function chooseView(selected: HTMLButtonElement) {
    for (const tab of [textTab, extractionTab]) {
      tab.setAttribute("aria-selected", String(tab === selected));
      tab.tabIndex = tab === selected ? 0 : -1;
    }
    body.setAttribute("aria-labelledby", selected.id);
    if (selected === textTab) textView();
    else extractionView();
  }
  const range = chunk.embedded_characters;
  const cropped = range !== null && range < chunk.characters;
  const characters = cropped ? Array.from(chunk.text) : [];
  function textView() {
    const text = reader(cropped ? characters.slice(0, range).join("") : chunk.text, "Source chunk");
    if (chunk.preceding) text.prepend(el("span", "inspector-context-boundary", "Start of Preceding Context"),
      el("span", "inspector-preceding", chunk.preceding),
      el("span", "inspector-context-boundary", `Start of B${chunk.book}:C${chunk.number}`));
    if (cropped) text.append("…", el("span", "inspector-cutoff", "Embedding cutoff"), characters.slice(range).join(""));
    const nodes: HTMLElement[] = [text];
    if (cropped) nodes.unshift(el("p", "inspector-cutoff-notice",
      `Embedding stopped at ${count(range)} / ${count(chunk.characters)} chars · exceeded token limit.`));
    body.replaceChildren(...nodes);
  }
  function extractionCounts(entityCount: number, relationshipCount: number) {
    return `${count(entityCount)} ${entityCount === 1 ? "entity" : "entities"} ·
      ${count(relationshipCount)} ${relationshipCount === 1 ? "relationship" : "relationships"}`.replace(/\s+/g, " ");
  }
  function extractionView() {
    body.replaceChildren(muted(`${extractionCounts(entities, totals.length - entities)} extracted`));
    if (!chunk.passes.length) body.append(muted("No successful extraction passes saved."));
    for (const pass of chunk.passes) {
      const row = el("details", "inspector-card");
      const label = pass.number ? `Gleaning pass ${pass.number}` : "Initial extraction";
      const totalEntities = pass.records.filter(item => item.kind === "entity").length;
      const summary = el("summary", "inspector-pass-summary");
      summary.append(el("span", "", label), el("small", "inspector-muted",
        pass.records.length ? extractionCounts(totalEntities, pass.records.length - totalEntities) : "Empty"));
      row.append(summary);
      for (const item of pass.records) {
        const card = el("article", "inspector-extraction-card");
        card.dataset.kind = item.kind;
        const title = el("div", "inspector-between");
        title.append(el("strong", "", item.kind === "entity" ? item.name : `${item.source.name} → ${item.target.name}`));
        const type = el("span", "inspector-extraction-type", item.kind === "entity" ? item.type : "Relationship");
        type.dataset.kind = item.kind;
        title.append(type);
        card.append(title, reader(item.description, label, onSource));
        row.append(card);
      }
      body.append(row);
    }
  }
  root.append(tabs, body);
  chooseView(initial === "extraction" ? extractionTab : textTab);
  return root;
}

export function booksView(loadBookPage: LoadBookPage, openChunk: (book: number, chunk: number) => void) {
  const root = el("div", "inspector-list");
  const catalogue = el("div", "inspector-list");
  const list = el("div", "inspector-list");
  const empty = muted("");
  catalogue.append(heading("Books & Chunks"), empty, list);
  root.append(catalogue);
  let overview: InspectorOverview;
  let opened: {
    id: string; root: HTMLElement; list: HTMLElement; next: HTMLButtonElement; error: HTMLElement; progress: HTMLProgressElement;
    trigger: HTMLElement; pages: number; request: number; refreshKey: string;
  } | undefined;

  function returnToBooks() {
    const state = opened;
    if (!state) return false;
    state.root.remove();
    opened = undefined;
    catalogue.hidden = false;
    state.trigger.focus({ preventScroll: true });
    return true;
  }

  const chunkCard = (book: number, item: InspectorChunkRow) => {
    const control = button("", () => openChunk(book, item.number), "inspector-chunk-row");
    const title = el("span", "inspector-chunk-title");
    title.append(el("strong"), el("small", "inspector-muted"));
    const description = el("span", "inspector-chunk-description");
    description.append(title, el("span", "inspector-muted inspector-chunk-preview"));
    const statuses = el("span", "inspector-chunk-statuses");
    statuses.append(el("span", "inspector-chunk-status"), el("span", "inspector-chunk-status"));
    const chevron = el("span", "inspector-chunk-chevron");
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML = icon("right");
    control.append(description, statuses, chevron);
    updateChunk(control, item);
    return control;
  };
  function updateChunk(node: HTMLElement, item: InspectorChunkRow) {
    const [title, snippet] = node.children[0].children;
    title.children[0].textContent = `Chunk ${count(item.number)}`;
    title.children[1].textContent = item.entities || item.relationships ? `${count(item.entities)}E · ${count(item.relationships)}R` : "";
    if (item.entities || item.relationships) {
      title.children[1].setAttribute("aria-label", `${item.entities} entities, ${item.relationships} relationships`);
    }
    const cleaned = item.preview.replace(/\b\d+\s*\|\s*P\s*a\s*g\s*e\b|\bPage\s+\d+\b/gi, "").replace(/\s+/g, " ").trim();
    snippet.textContent = cleaned || item.preview.replace(/\s+/g, " ").trim();
    const updateBadge = (target: HTMLElement, kind: "Embedded" | "Extracted", status: ChunkStatus) => {
      const complete = status === "complete";
      target.dataset.state = complete ? "complete" : "incomplete";
      target.textContent = kind;
      target.setAttribute("aria-label", complete ? kind : `Not yet ${kind.toLowerCase()}`);
    };
    const statuses = node.children[1];
    updateBadge(statuses.children[0] as HTMLElement, "Embedded", item.embedding_status);
    updateBadge(statuses.children[1] as HTMLElement, "Extracted", item.extraction_status);
  }

  async function populate() {
    const state = opened;
    if (!state) return;
    const book = overview.world.books.find(book => book.id === state.id);
    if (!book) return;
    const run = ++state.request;
    state.next.disabled = true;
    try {
      const pages = [];
      for (let page = 0; page < state.pages; page++) {
        pages.push(await loadBookPage(book.id, page * 60));
        if (opened !== state || run !== state.request) return;
        if (!pages.at(-1)?.more) break;
      }
      const items = pages.flatMap(page => page.items);
      state.next.hidden = !pages.at(-1)?.more;
      state.error.replaceChildren(...(items.length ? [] : [muted("No chunks in this book yet.")]));
      patchList(state.list, items, item => String(item.number), item => chunkCard(book.number, item), updateChunk);
    } catch (error) {
      if (opened === state && run === state.request && root.isConnected) state.error.replaceChildren(notice(error, () => { void populate(); }));
    } finally {
      if (run === state.request) state.next.disabled = false;
    }
  }

  function openBook(bookId: string, trigger: HTMLElement) {
    const book = overview.world.books.find(item => item.id === bookId);
    if (!book) return;
    const detail = el("div", "inspector-list inspector-book-detail");
    const chunkList = el("div", "inspector-list");
    const more = button("Load More Chunks", () => { if (opened) opened.pages++; void populate(); });
    const error = el("div");
    const progress = el("progress", "inspector-meter inspector-book-progress");
    const state = { id: bookId, root: detail, list: chunkList, next: more, error, progress, trigger,
      pages: 1, request: 0, refreshKey: "" };
    opened = state;
    const back = backControl("Books", returnToBooks);
    more.hidden = true;
    detail.append(readerHeading(book.name, back), progress, error, chunkList, more);
    catalogue.hidden = true;
    root.append(detail);
    root.closest(".inspector-main")?.scrollTo(0, 0);
    back.focus({ preventScroll: true });
    refreshBook(book);
  }
  function bookRow(book: Book) {
    const control = button("", () => openBook(book.id, control), "inspector-card inspector-book-heading");
    control.append(el("strong"), el("span", "inspector-muted"), el("span"), el("progress", "inspector-meter"));
    updateBook(control, book);
    return control;
  }
  function updateBook(row: HTMLElement, book: Book) {
    const progress = percent(book, Boolean(overview.world.graph));
    row.children[0].textContent = book.name;
    row.children[1].textContent = `Book ${book.number} · ${count(book.total_chunks)} chunks`;
    row.children[2].textContent = `${progress}% ›`;
    setMeter(row.querySelector("progress")!, progress, 100, book.name, "");
  }
  function refreshBook(book: Book) {
    if (!opened) return;
    setMeter(opened.progress, percent(book, Boolean(overview.world.graph)), 100, "Book Indexing Progress", "");
    const activity = overview.events.filter(event => event.location.book === book.number).at(-1)?.id;
    const key = [overview.world.book_revision, book.number, book.total_chunks, book.embedded_chunks, book.extracted_chunks, activity].join(":");
    if (opened.refreshKey === key) return;
    opened.refreshKey = key;
    void populate();
  }
  return {
    root, escape: returnToBooks,
    update(data: InspectorOverview) {
      overview = data;
      if (opened) {
        const current = data.world.books.find(book => book.id === opened?.id);
        if (current) refreshBook(current);
        else returnToBooks();
      }
      empty.hidden = Boolean(data.world.books.length);
      empty.textContent = "No books in this World.";
      patchList(list, data.world.books, book => book.id, bookRow, updateBook);
    },
  };
}
