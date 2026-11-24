import type { TaleSearchResult, TaleSummary, World } from "../../shared/types.js";
import { orderedTales, recentTime, removeTale, request, storeTale, taleRoute, tales, worlds, type OpenTale } from "../data.js";
import { previewDialog } from "../dialog.js";
import { element } from "../dom.js";
import { historyFrames, setSurfaceVisible } from "../motion.js";
import { showToast } from "../toasts.js";
import { homeView, idleView, recentCollapsed, recentTaleRows, taleRows } from "../view.js";
import { followLatestDuringResize, keepReadingPosition } from "./reading-position.js";

type TaleListOptions = {
  workspace: HTMLElement;
  currentWorld: () => World | undefined;
  currentTale: () => OpenTale | undefined;
  closeDrawer: () => void;
  openTale: (world: World, tale: TaleSummary) => Promise<void>;
  openListedTale: (world: World, tale: TaleSummary) => void;
  goHome: () => void;
  forgetDraft: (id: string) => void;
};

export function createTaleLists({ workspace, currentWorld, currentTale, closeDrawer, openTale, openListedTale,
  goHome, forgetDraft }: TaleListOptions) {
  let expanded = false;
  let historyOpen = false;
  let homeQuery = "";
  let searchResults: TaleSearchResult[] = [];
  let searchTimer: number | undefined;
  let searchRequest: AbortController | undefined;
  let searchedWorldNames = "";

  function cancelTaleSearch() {
    window.clearTimeout(searchTimer);
    searchRequest?.abort();
    searchRequest = undefined;
    searchResults = [];
  }

  function updateTaleSearch(input: HTMLInputElement, debounce = true) {
    cancelTaleSearch();
    const world = input.id === "world-tale-search" ? currentWorld() : undefined;
    const list = element(world ? "history-list" : "recent-tales");
    const more = workspace.querySelector<HTMLButtonElement>('[data-action="expand-recent"]');
    const query = input.value.trim();
    if (more) more.hidden = !!query || tales.length <= recentCollapsed;
    if (!query) {
      list.removeAttribute("aria-busy");
      list.innerHTML = world ? taleRows(orderedTales(world), currentTale()?.id)
        : recentTaleRows(orderedTales(), expanded, false);
      return;
    }

    list.setAttribute("aria-busy", "true");
    const search = async () => {
      const controller = new AbortController();
      searchRequest = controller;
      const params = new URLSearchParams({ q: query });
      if (world) params.set("world", world.id);
      try {
        const results = await request<TaleSearchResult[]>(`/api/tales/search?${params}`, undefined, controller.signal);
        if (controller.signal.aborted || !input.isConnected) return;
        searchResults = results;
        list.innerHTML = world && results.length ? taleRows(results, currentTale()?.id)
          : recentTaleRows(results, expanded, true);
      } catch (error) {
        if (!controller.signal.aborted && input.isConnected) showToast(error, { key: "tale-search" });
      } finally {
        if (!controller.signal.aborted) list.removeAttribute("aria-busy");
      }
    };
    if (debounce) searchTimer = window.setTimeout(() => void search(), 175);
    else void search();
  }

  function renderHistory() {
    updateTaleSearch(element<HTMLInputElement>("world-tale-search"), false);
  }

  function setHistory(show: boolean, returnFocus = false) {
    const toggle = workspace.querySelector<HTMLButtonElement>('[data-action="toggle-history"]');
    if (!toggle) return;
    if (show) closeDrawer();
    if (show) renderHistory();
    else cancelTaleSearch();
    const history = element("tale-history");
    const transcript = element("transcript");
    const followingLatest = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop < 3;
    keepReadingPosition(() => {
      historyOpen = show;
      const motion = setSurfaceVisible(history, show, historyFrames);
      if (motion && followingLatest) followLatestDuringResize(transcript, motion);
      toggle.setAttribute("aria-expanded", String(show));
    });
    if (show) element("history-list").focus({ preventScroll: true });
    if (returnFocus) toggle.focus({ preventScroll: true });
  }

  function refreshTaleLists() {
    if (historyOpen) renderHistory();
    if (!currentTale()) {
      updateTaleSearch(element<HTMLInputElement>("home-tale-search"), false);
    }
  }

  function restoreRowFocus(button: HTMLButtonElement) {
    if (button.isConnected) {
      button.focus({ preventScroll: true });
      return;
    }
    const { action, id } = button.dataset;
    const replacement = [...workspace.querySelectorAll<HTMLButtonElement>("[data-action]")]
      .find(candidate => candidate.getClientRects().length
        && candidate.dataset.action === action && candidate.dataset.id === id);
    (replacement ?? element("screen-title")).focus({ preventScroll: true });
  }

  function editTale(action: "rename" | "delete", tale: TaleSummary, button: HTMLButtonElement) {
    const isRename = action === "rename";
    const options = isRename
      ? { title: "Rename Tale", initialName: tale.title, nameLabel: "Tale name" }
      : { title: "Delete Tale?", detail: `Permanently remove “${tale.title}” and its messages?`, danger: true };
    previewDialog(options, async name => {
      try {
        const current = currentTale();
        const open = tale.id === current?.id ? current : undefined;
        if (!open?.draft) await request(`${taleRoute(tale)}/${action}`, isRename ? { title: name } : {});
        if (isRename) {
          tale.title = name;
          if (open) {
            open.title = name;
            const heading = element("screen-title");
            heading.textContent = name;
            heading.dataset.tooltip = name;
          }
          refreshTaleLists();
        } else {
          removeTale(tale.id);
          forgetDraft(tale.id);
          const world = currentWorld();
          if (open && world) {
            const latest = latestTale(world);
            if (latest) await openTale(world, latest);
            else goHome();
          } else refreshTaleLists();
        }
      } catch (error) { showToast(error); }
    }, () => restoreRowFocus(button));
  }

  function showHome() {
    cancelTaleSearch();
    workspace.innerHTML = idleView(homeView(orderedTales(), expanded));
    const input = element<HTMLInputElement>("home-tale-search");
    input.value = homeQuery;
    if (homeQuery.trim()) updateTaleSearch(input, false);
  }

  function reset() {
    historyOpen = false;
    cancelTaleSearch();
  }

  function refreshWorldNames() {
    const worldNames = JSON.stringify(worlds.map(world => [world.id, world.name]).sort());
    if (searchedWorldNames !== worldNames) {
      searchedWorldNames = worldNames;
      const input = document.querySelector<HTMLInputElement>("#home-tale-search");
      if (input?.value.trim()) updateTaleSearch(input, false);
    }
  }

  function handleAction(action: string | undefined, id: string | undefined, button: HTMLButtonElement) {
    const current = currentTale();
    const tale = id && current?.id === id ? current : tales.find(entry => entry.id === id) ?? searchResults.find(entry => entry.id === id);
    switch (action) {
      case "open-tale": {
        const world = worlds.find(item => item.id === tale?.world_id);
        if (tale && world) openListedTale(world, tale);
        break;
      }
      case "toggle-history": setHistory(!historyOpen); break;
      case "expand-recent":
        expanded = !expanded;
        showHome();
        if (expanded) workspace.querySelectorAll<HTMLButtonElement>(".tale-link")[recentCollapsed]?.focus();
        else restoreRowFocus(button);
        break;
      case "pin-tale":
        if (tale) {
          void request(taleRoute(tale) + "/pin", { pinned: !tale.pinned }).then(() => {
            tale.pinned = !tale.pinned;
            storeTale(tale);
            refreshTaleLists();
            restoreRowFocus(button);
          }).catch(error => showToast(error));
        }
        break;
      case "rename-tale":
      case "delete-tale":
        if (tale) editTale(action === "rename-tale" ? "rename" : "delete", tale, button);
        break;
      default: return false;
    }
    return true;
  }

  function initialize() {
    workspace.addEventListener("input", event => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || !["home-tale-search", "world-tale-search"].includes(input.id)) return;
      if (input.id === "home-tale-search") homeQuery = input.value;
      updateTaleSearch(input);
    });
  }

  return { get historyOpen() { return historyOpen; }, initialize, reset, showHome, setHistory,
    refreshTaleLists, refreshWorldNames, handleAction };
}

export function latestTale(world: World) {
  return tales.filter(tale => tale.world_id === world.id).sort((a, b) => recentTime(b) - recentTime(a))[0];
}
