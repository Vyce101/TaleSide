import type { HistoryTrace, MessageContext, PassageTrace } from "../../shared/inspectors.js";
import type { Message, Tale } from "../../shared/types.js";
import { request, taleRoute } from "../data.js";
import { setSurfaceVisible, slideFrames } from "../motion.js";
import { backControl, button, copyControl, count, el, iconControl, muted, notice, readableRequest, reader, readerHeading, replacePanel, select, setMeter } from "./ui.js";
import { createMessageContextGraph } from "./message-context-graph.js";

const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
const preview = (text: string) => text.length > 260 ? text.slice(0, 260).trimEnd() + "…" : text;

export function createMessageContext(panel: HTMLElement) {
  const sidebar = panel.querySelector<HTMLElement>(".inspector-sidebar")!;
  const main = panel.querySelector<HTMLElement>(".inspector-main")!;
  let controller: AbortController | undefined;
  let trigger: HTMLElement | undefined;
  let data: MessageContext;
  let tab = "raw";
  let rawMode: "readable" | "json" = "readable";
  let chunkOrder: "sent" | "similarity" = "sent";
  let closeReader: (() => void) | undefined;
  let graphView: ReturnType<typeof createMessageContextGraph> | undefined;

  function closeSection() {
    graphView?.close();
    graphView = undefined;
    closeReader = undefined;
  }

  function close(restore = true) {
    if (!controller) return;
    controller.abort();
    controller = undefined;
    closeSection();
    setSurfaceVisible(panel, false, slideFrames, () => {
      if (controller) return;
      sidebar.replaceChildren();
      main.replaceChildren();
      if (restore && trigger?.isConnected) trigger.focus({ preventScroll: true });
      trigger = undefined;
    });
  }

  function choose(view: string) {
    tab = view;
    closeSection();
    tabs();
    content();
    sidebar.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
  }

  function tabs() {
    const raw = button("Raw Request", () => choose("raw"), "inspector-nav-row inspector-raw-row");
    raw.append(el("small", "", count(data.characters)));
    raw.setAttribute("aria-pressed", String(tab === "raw"));
    sidebar.replaceChildren(raw);
    const ratio = (chars: number) => data.characters ? chars / data.characters : 0;
    function row(key: string, label: string, chars: number, share = ratio(chars)) {
      const control = button("", () => choose(key), "inspector-nav-row");
      control.style.setProperty("--inspector-fill", `${ratio(chars) * 100}%`);
      control.setAttribute("aria-pressed", String(key === tab));
      control.append(el("span", "inspector-share", percent.format(share)),
        el("span", "inspector-nav-label", label), el("small", "", count(chars)));
      return control;
    }
    for (const item of data.trace.sections) {
      const key = `block:${item.id}`;
      if (item.kind !== "retrieved_passages") {
        sidebar.append(row(key, item.name, item.characters));
        continue;
      }
      const group = el("section", "inspector-retrieved-group");
      const summary = el("div", "inspector-retrieved-summary");
      const title = el("h3", "", item.name);
      title.id = `xray-section-${item.id}`;
      group.setAttribute("aria-labelledby", title.id);
      const progress = el("progress", "inspector-meter");
      setMeter(progress, item.characters, data.characters, `${item.name} share of request`, "");
      const share = el("div", "inspector-retrieved-share");
      share.append(el("small", "", percent.format(ratio(item.characters))), progress,
        el("small", "", count(item.characters)));
      summary.append(title, share);

      const { graph_characters: graph, chunk_characters: chunks } = data.trace;
      const sent = data.trace.chunks.filter(chunk => chunk.included).length;
      const roundedRatio = (chars: number) => Math.round(1000 * ratio(chars)) / 1000;
      const views = el("div", "inspector-retrieved-views");
      views.append(
        row("chunks", `Chunks · ${count(sent)}`, chunks, roundedRatio(item.characters) - roundedRatio(graph)),
        row("graph", data.trace.graph_preview ? "Graph Preview" : "Graph", graph),
      );
      group.append(summary, views);
      sidebar.append(group);
    }
  }

  function showReader(title: string, description: string, text: string,
    { thinking, overlap }: { thinking?: string; overlap?: { label: string; text: string } } = {}) {
    const position = main.scrollTop;
    const back = backControl(tab === "chunks" ? "Chunks" : "Chat History", () => closeReader?.());
    closeReader = () => {
      closeReader = undefined;
      content();
      main.scrollTop = position;
      main.querySelector<HTMLElement>("button, select, [tabindex]")?.focus({ preventScroll: true });
    };
    const nodes: HTMLElement[] = [readerHeading(title, back), muted(description)];
    if (thinking) {
      const thoughts = el("div", "inspector-thinking");
      thoughts.append(el("strong", "", "Thinking sent"), reader(thinking, "Thinking sent"));
      nodes.push(thoughts);
    }
    const passage = reader(text, title);
    if (overlap) passage.prepend(
      el("span", "inspector-context-boundary", overlap.label),
      el("span", "inspector-preceding", overlap.text),
      el("span", "inspector-context-boundary", "Chunk text"),
    );
    nodes.push(passage);
    if (!description) nodes.splice(1, 1);
    replacePanel(main, nodes);
    back.focus();
  }

  function chunkCard(chunk: PassageTrace) {
    const metaText = `Book ${chunk.book} · Chunk ${chunk.chunk}`;
    const score = percent.format(chunk.similarity);
    const overlap = chunk.preceding ? { label: `Preceding context (Chunk ${chunk.chunk - 1})`, text: chunk.preceding } : undefined;
    const card = button("", () => showReader(chunk.name, [metaText, "Included", score].join(" · "), chunk.text, { overlap }),
      "inspector-card inspector-xray-chunk");
    const description = el("span", "inspector-xray-chunk-description");
    const status = el("span", "inspector-xray-chunk-status");
    status.append(el("span", "inspector-score", score), el("span", "inspector-muted", "Included"));
    const bar = el("span", "inspector-similarity");
    const similarity = Math.max(0, Math.min(1, chunk.similarity));
    bar.style.setProperty("--inspector-score", `${similarity * 100}%`);
    bar.style.setProperty("--inspector-brightness", String(0.4 + 0.6 * similarity));
    description.append(el("strong", "", chunk.name), el("span", "inspector-muted", metaText), bar);
    card.append(description, status, el("span", "inspector-preview", preview(chunk.text.replace(/\s+/g, " ").trim())));
    return card;
  }

  function chunks() {
    const trace = data.trace;
    const list = el("div", "inspector-list");
    const sent = trace.chunks.filter(chunk => chunk.included);
    const controls = el("div", "inspector-controls");
    controls.append(select("Chunk order", [["sent", "Sent Order"], ["similarity", "Similarity"]], chunkOrder, value => {
      chunkOrder = value; populate();
    }), el("span", "inspector-inline-total inspector-muted", `${count(sent.length)} ${sent.length === 1 ? "chunk" : "chunks"} sent`));
    function populate() {
      const items = [...sent];
      if (chunkOrder === "similarity") items.sort((a, b) => b.similarity - a.similarity || a.book - b.book || a.chunk - b.chunk);
      list.replaceChildren(...(items.length ? items.map(chunkCard) : [muted("No chunks in this request.")]));
    }
    populate();
    return [controls, list];
  }

  function historyCard(turn: HistoryTrace) {
    const thinking = turn.role === "user" ? "" : turn.thinking ? "Thinking Sent" : turn.has_thinking ? "Thinking Saved, Not Sent" : "Thinking Unavailable";
    const status = [turn.model, thinking, turn.signature_sent ? "Signature Sent" : turn.has_signature ? "Signature Not Sent" : ""].filter(Boolean).join(" · ");
    const label = `Turn ${turn.turn} · ${turn.name}`;
    const card = button("", () => showReader(label, status, turn.text, { thinking: turn.thinking }), "inspector-card inspector-xray-history");
    card.append(el("strong", "", label), el("span", "inspector-preview", preview(turn.text.replace(/\s+/g, " ").trim())));
    if (status) card.append(el("small", "inspector-muted", status));
    return card;
  }

  function history() {
    const list = el("div", "inspector-list");
    const values = [...data.trace.history].reverse();
    list.append(...(values.length ? values.map(historyCard) : [muted("No history in this request.")]));
    return [list];
  }

  function content() {
    const section = data.trace.sections.find(item => `block:${item.id}` === tab);
    if (tab === "raw") {
      const code = reader("", "Request");
      const readable = readableRequest(data.raw);
      const display = () => { code.textContent = rawMode === "readable" ? readable : data.raw; };
      const toolbar = el("header", "inspector-xray-tools");
      const readableMode = iconControl("Readable", "page", () => setMode("readable"));
      const raw = iconControl("Raw JSON", "code", () => setMode("json"));
      function setMode(mode: typeof rawMode) {
        rawMode = mode;
        readableMode.setAttribute("aria-pressed", String(mode === "readable"));
        raw.setAttribute("aria-pressed", String(mode === "json"));
        display();
      }
      toolbar.append(readableMode, raw, copyControl(() => code.textContent ?? "", code, true));
      setMode(rawMode);
      replacePanel(main, [toolbar, code]);
    } else if (tab === "chunks") replacePanel(main, chunks());
    else if (tab === "graph") {
      graphView = createMessageContextGraph(data.trace);
      replacePanel(main, graphView.content);
    } else if (section?.kind === "chat_history") replacePanel(main, history());
    else if (section) replacePanel(main, [section.text ? reader(section.text, section.name) : muted("No text from this section was sent.")]);
  }

  async function open(tale: Tale, message: Message, from: HTMLElement) {
    controller?.abort();
    const run = new AbortController();
    controller = run;
    trigger = from;
    chunkOrder = "sent";
    closeSection();
    sidebar.replaceChildren();
    replacePanel(main, [muted("Loading saved request…")], false);
    setSurfaceVisible(panel, true, slideFrames);
    panel.querySelector<HTMLElement>(".panel-back")!.focus({ preventScroll: true });
    try {
      const capture = await request<MessageContext>(`${taleRoute(tale)}/xray?message=${message.id}&swipe=${message.swipe ?? 0}`, undefined, run.signal);
      if (run.signal.aborted) return;
      if (capture.trace.graph_preview?.message_id !== message.id) delete capture.trace.graph_preview;
      data = capture;
      const first = data.trace.sections.find(section => section.kind !== "retrieved_passages");
      tab = first ? `block:${first.id}` : "raw";
      tabs();
      content();
    } catch (error) {
      if (!run.signal.aborted) replacePanel(main, [notice(error, () => { void open(tale, message, from); })]);
    }
  }

  return {
    open, close, get visible() { return Boolean(controller); },
    escape() { if (closeReader) closeReader(); else if (!graphView?.closeRecord()) close(); },
  };
}
