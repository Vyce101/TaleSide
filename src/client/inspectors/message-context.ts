import type { MessageContext } from "../../shared/inspectors.js";
import type { Message, Tale } from "../../shared/types.js";
import { request, taleRoute } from "../data.js";
import { setSurfaceVisible, slideFrames } from "../motion.js";
import { button, copyControl, count, el, iconControl, muted, notice, readableRequest, reader, replacePanel } from "./ui.js";


const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });

export function createMessageContext(panel: HTMLElement) {
  const sidebar = panel.querySelector<HTMLElement>(".inspector-sidebar")!;
  const main = panel.querySelector<HTMLElement>(".inspector-main")!;
  let controller: AbortController | undefined;
  let trigger: HTMLElement | undefined;
  let data: MessageContext;
  let tab = "raw";
  let rawMode: "readable" | "json" = "readable";

  function close(restore = true) {
    if (!controller) return;
    controller.abort();
    controller = undefined;
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
    function row(key: string, label: string, chars: number) {
      const control = button("", () => choose(key), "inspector-nav-row");
      control.style.setProperty("--inspector-fill", `${ratio(chars) * 100}%`);
      control.setAttribute("aria-pressed", String(key === tab));
      control.append(el("span", "inspector-share", percent.format(ratio(chars))),
        el("span", "inspector-nav-label", label), el("small", "", count(chars)));
      return control;
    }
    for (const item of data.trace.sections) {
      if (item.kind === "chat_history" || item.kind === "retrieved_passages") continue;
      const key = "block:" + item.id;
      sidebar.append(row(key, item.name, item.characters));
    }
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
    }
    else if (section) replacePanel(main, [section.text ? reader(section.text, section.name) : muted("No text from this section was sent.")]);
  }

  async function open(tale: Tale, message: Message, from: HTMLElement) {
    controller?.abort();
    const run = new AbortController();
    controller = run;
    trigger = from;
    sidebar.replaceChildren();
    replacePanel(main, [muted("Loading saved request…")], false);
    setSurfaceVisible(panel, true, slideFrames);
    panel.querySelector<HTMLElement>(".panel-back")!.focus({ preventScroll: true });
    try {
      const capture = await request<MessageContext>(`${taleRoute(tale)}/xray?message=${message.id}&swipe=${message.swipe ?? 0}`, undefined, run.signal);
      if (run.signal.aborted) return;
      if (capture.trace.graph_preview?.message_id !== message.id) delete capture.trace.graph_preview;
      data = capture;
      const first = data.trace.sections.find(section => section.kind !== "retrieved_passages" && section.kind !== "chat_history");
      tab = first ? `block:${first.id}` : "raw";
      tabs();
      content();
    } catch (error) {
      if (!run.signal.aborted) replacePanel(main, [notice(error, () => { void open(tale, message, from); })]);
    }
  }

  return {
    open, close, get visible() { return Boolean(controller); },
    escape() { close(); },
  };
}
