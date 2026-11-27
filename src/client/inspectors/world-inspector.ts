import type { InspectorOverview } from "../../shared/inspectors.js";
import type { World } from "../../shared/types.js";
import { request, worldRoute } from "../data.js";
import { overviewView } from "./world-overview.js";
import { button, notice, replacePanel } from "./ui.js";

type Tab = "overview";
type View = { root: HTMLElement; update: (overview: InspectorOverview) => void; escape?: () => boolean; close?: () => void };
const tabs: [Tab, string][] = [["overview","Overview"]];

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
  let polling = false;

  function read<T>(action: string, params: Record<string, string> = {}) {
    return request<T>(`${worldRoute(worldId)}/${action}?${new URLSearchParams(params)}`, undefined, controller?.signal);
  }

  async function change(action: "pause" | "resume") {
    const world = await request<World>(`${worldRoute(worldId)}/${action}`, {}, controller?.signal);
    worldUpdated(world);
    await poll();
  }

  function selectTab(next: Tab) {
    tab = next;
    view?.close?.();
    for (const row of sidebar.querySelectorAll<HTMLButtonElement>("button")) row.setAttribute("aria-pressed", String(row.dataset.tab === tab));
    view = overviewView(change);
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
      return view?.escape?.() ?? false;
    },
  };
}
