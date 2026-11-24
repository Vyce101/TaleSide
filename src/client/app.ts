import type { Tale, TaleSummary, World } from "../shared/types.js";
import { loadTales, loadWorlds, request, storeWorld, taleRoute, worlds, type OpenTale } from "./data.js";
import { initializeDialog, outside } from "./dialog.js";
import { element } from "./dom.js";
import { createKeysPanel } from "./keys-panel.js";
import { setSurfaceVisible, slideFrames } from "./motion.js";
import { createPersonaPanel } from "./personas.js";
import { createTaleLists, latestTale } from "./tales/lists.js";
import { keepReadingPosition } from "./tales/reading-position.js";
import { createTaleSettings } from "./tales/settings.js";
import { createTaleWorkspace, draftTale } from "./tales/workspace.js";
import { clearToast, showToast } from "./toasts.js";
import { initializeTooltips } from "./tooltips.js";
import { icon, type Icon } from "./view.js";
import { createWorldEditor } from "./worlds/editor.js";

const workspace = element("workspace");
const workbench = element("workbench");
const drawers = {
  worlds: element("worlds-drawer"),
  settings: element("settings-drawer"),
  keys: element("keys-drawer"),
  personas: element("personas-drawer"),
  "app-settings": element("app-settings-drawer"),
};
type Panel = keyof typeof drawers;
const panelNames = { worlds: "Worlds", settings: "Tale Settings", keys: "API Keys", "app-settings": "Settings", personas: "Personas", inspector: "World Inspector" };
const narrow = matchMedia("(width < 1100px)");

const panelButtons = document.querySelectorAll<HTMLButtonElement>(".toolbar [data-panel]");
let panel: Panel | null = null;
let navigation = 0;
let lastWorlds = new Map<string, World>();

const taleWorkspace = createTaleWorkspace({
  workspace,
  currentChatSettings: () => taleSettings.currentChatSettings(),
  currentPersona: () => personas.currentPersona(),
  onBranch: navigate,
  onTalesChanged: () => { taleLists.refreshTaleLists(); },
});
const taleLists = createTaleLists({
  workspace,
  currentWorld: () => taleWorkspace.world,
  currentTale: () => taleWorkspace.tale,
  closeDrawer: () => showPanel(null, false),
  openTale: (world, tale) => openTale(world, tale, false),
  openListedTale: (world, tale) => worldEditor.leaveWorldSetup(() => { void openTale(world, tale, false); }),
  goHome: () => navigate(),
  forgetDraft: taleWorkspace.clearDraft,
});
const worldEditor = createWorldEditor({
  currentWorld: () => taleWorkspace.world,
  isOpen: () => panel === "worlds",
  showWorldPanel: () => showPanel("worlds", false),
  enterWorld,
  goHome: () => navigate(),
  onWorldUpdated: updateWorld,
});
const taleSettings = createTaleSettings({
  currentWorld: () => taleWorkspace.world,
  onWorldUpdated: updateWorld,
  onChatSettingsChanged: taleWorkspace.refreshComposer,
});
const keysPanel = createKeysPanel({
  isOpen: () => panel === "keys",
  onKeysChanged: () => {
    taleSettings.renderChatKey();
    if (panel === "settings") taleSettings.renderWorldContext();
    worldEditor.updateWorldEditorKeys();
    taleWorkspace.refreshComposer();
  },
  onWorldsReloaded: syncWorlds,
});
const personas = createPersonaPanel({
  currentWorld: () => taleWorkspace.world,
  currentTale: () => taleWorkspace.tale,
  isOpen: () => panel === "personas",
});

function updatePanelLayout() {
  const showFullWidth = narrow.matches && panel !== null && panel !== "keys" && panel !== "personas" && panel !== "app-settings";
  workspace.inert = showFullWidth;
  if (!panel) return;
  const back = drawers[panel].querySelector<HTMLButtonElement>(".panel-back")!;
  const label = showFullWidth ? "Back" : "Close panel";
  back.innerHTML = showFullWidth ? `${icon("back")}<span>Back</span>` : icon("close");
  back.setAttribute("aria-label", label);
  back.dataset.tooltip = label;
}

function setPanelSide(next: Panel | null) {
  const side = next === "worlds" ? "right" : next === "settings" ? "left" : "";
  const update = () => { workbench.dataset.side = side; };
  if (!narrow.matches && Boolean(workbench.dataset.side) !== Boolean(side)) keepReadingPosition(update);
  else update();
}

function showPanel(next: Panel | null, returnFocus = true) {
  const previous = panel;
  if (previous === next) return;
  panel = next;
  for (const button of panelButtons) {
    if (!button.disabled) button.setAttribute("aria-expanded", String(button.dataset.panel === next));
  }
  if (next && taleLists.historyOpen) taleLists.setHistory(false);

  if (previous) {
    setSurfaceVisible(drawers[previous], false, slideFrames, () => {
      if (previous === "worlds") worldEditor.hideWorldPanel();
      if (previous === "keys") keysPanel.closeKeyEditor();
      if (!next && !panel && returnFocus) element(`${previous}-button`).focus({ preventScroll: true });
    });
  }
  if (next) setSurfaceVisible(drawers[next], true, slideFrames);
  setPanelSide(next);
  updatePanelLayout();
  if (!next) return;

  if (next === "worlds") worldEditor.restoreWorldPanel();
  if (next === "keys") {
    keysPanel.renderKeysView();
    void keysPanel.refreshKeys().catch(error => showToast(error));
  }
  if (next === "settings") taleSettings.renderWorldContext();
  if (next === "personas") void personas.refreshPersonas();
  const drawer = drawers[next];
  drawer.querySelector(".panel-content")!.scrollTop = 0;
  drawer.querySelector<HTMLButtonElement>(".panel-back")!.focus({ preventScroll: true });
}

function setWorkspace(world?: World, tale?: OpenTale) {
  taleWorkspace.select(world, tale);
  if (world) void personas.refreshPersonas();
  taleLists.reset();
  element("home-button").setAttribute("aria-current", String(!world));
  if (tale && world) taleWorkspace.render();
  else taleLists.showHome();
}

function navigate(world?: World, tale?: OpenTale) {
  navigation++;
  showPanel(null, false);
  setWorkspace(world, tale);
  element("screen-title").focus({ preventScroll: true });
}

async function openTale(world: World, tale: TaleSummary | undefined, inSidebar: boolean) {
  const revision = ++navigation;
  try {
    const currentTale = taleWorkspace.tale;
    const selected = currentTale?.id === tale?.id && currentTale ? currentTale
      : tale ? await request<Tale>(taleRoute(tale)) : draftTale(world);
    if (navigation !== revision) return;
    const currentWorld = worlds.find(item => item.id === world.id) ?? world;
    taleWorkspace.warnMissingKeys(currentWorld);
    if (inSidebar) {
      if (taleWorkspace.world?.id !== currentWorld.id || !taleWorkspace.tale) setWorkspace(currentWorld, selected);
      if (panel === "worlds") worldEditor.openWorldEditor(currentWorld);
    } else navigate(currentWorld, selected);
  } catch (error) { if (navigation === revision) showToast(error); }
}

function enterWorld(world: World) {
  return openTale(world, latestTale(world), true);
}

function newTale() {
  const world = taleWorkspace.world;
  if (!world?.can_play) return;
  navigate(world, draftTale(world));
  element("message-input").focus({ preventScroll: true });
}

function updateWorld(world: World) {
  storeWorld(world);
  syncWorlds();
}

function syncWorlds() {
  for (const world of worlds) {
    const previous = lastWorlds.get(world.id);
    if (!previous || previous.status === world.status || worldEditor.isWorldEditorOpen(world.id)) continue;
    if (world.status === "failed") showToast(`${world.name}: ${world.error ?? "Indexing failed."}`);
    if (world.status === "ready" && ["creating", "pausing"].includes(previous.status)) {
      showToast(`${world.name} finished indexing.`, { success: true });
    }
  }
  lastWorlds = new Map(worlds.map(world => [world.id, world]));
  taleLists.refreshWorldNames();
  const current = worlds.find(world => world.id === taleWorkspace.world?.id);
  if (current) taleWorkspace.syncWorld(current);
  worldEditor.syncWorldPanel();
}

initializeDialog(event => {
  if (panel && outside(event, drawers[panel])) showPanel(null);
  if (taleLists.historyOpen && outside(event, element("tale-history"))) taleLists.setHistory(false, true);
});

for (const button of panelButtons) {
  const name = button.dataset.panel as keyof typeof panelNames;
  const glyph: Icon = name === "keys" ? "key" : name === "app-settings" ? "gear" : name === "inspector" ? "search" : name;
  button.innerHTML = icon(glyph);
  button.setAttribute("aria-label", panelNames[name]);
  button.dataset.tooltip = panelNames[name];
  if (name !== "inspector") button.addEventListener("click", () => showPanel(panel === name ? null : name));
}

element("home-button").addEventListener("click", () => worldEditor.leaveWorldSetup(() => navigate()));
for (const drawer of Object.values(drawers)) {
  drawer.querySelector(".panel-back")!.addEventListener("click", () => showPanel(null));
}
document.addEventListener("click", event => {
  if ((!panel && !taleLists.historyOpen) || !(event.target instanceof Element)
    || event.target.closest(".toolbar button, dialog[open], #toasts")) return;
  if (panel && drawers[panel].contains(event.target)) return;
  if (taleLists.historyOpen && event.target.closest('#tale-history, [data-action="toggle-history"]')) return;
  const clickedControl = event.target.closest("button, a[href], input, select, textarea, label, summary, [tabindex], [contenteditable=true]");
  if (taleLists.historyOpen) taleLists.setHistory(false, !clickedControl);
  else showPanel(null, !clickedControl);
}, { capture: true });
narrow.addEventListener("change", () => {
  const focusInWorkspace = workspace.contains(document.activeElement);
  updatePanelLayout();
  if (workspace.inert && focusInWorkspace && panel) {
    drawers[panel].querySelector<HTMLButtonElement>(".panel-back")!.focus({ preventScroll: true });
  }
});

document.addEventListener("click", event => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (button.closest(".turn")) { void taleWorkspace.handleTurn(button); return; }
  switch (action) {
    case "open-world": {
      const world = worlds.find(entry => entry.id === id);
      if (world) void enterWorld(world);
      break;
    }
    case "new-tale": newTale(); break;
    case "close-tale": navigate(); break;
    default:
      if (!taleLists.handleAction(action, id, button)) worldEditor.handleWorldAction(action, id, button);
  }
});

document.addEventListener("wheel", event => {
  if (event.ctrlKey || !event.deltaY || panel === "worlds" || panel === "settings"
    || document.querySelector("dialog[open]")) return;
  const origin = event.target;
  if (!(origin instanceof Element) || origin.closest("textarea, select, #toasts")) return;
  const scroller = panel ? drawers[panel].querySelector<HTMLElement>(".panel-content")
    : taleLists.historyOpen ? document.getElementById("history-list")
    : document.getElementById("transcript") ?? workspace.querySelector<HTMLElement>(".home-view");
  if (!scroller || scroller.contains(origin) || scroller.scrollHeight <= scroller.clientHeight) return;
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? scroller.clientHeight : 1;
  event.preventDefault();
  scroller.scrollTop += event.deltaY * unit;
}, { passive: false });

document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
  if (panel) showPanel(null);
  else if (taleLists.historyOpen) taleLists.setHistory(false, true);
});

initializeTooltips();
taleLists.initialize();
taleWorkspace.initialize();
keysPanel.initialize();
setWorkspace();
void Promise.all([loadWorlds(), loadTales(), taleSettings.initialize(), keysPanel.refreshKeys()]).then(() => {
  syncWorlds();
  taleLists.refreshTaleLists();
}).catch(error => showToast(error));

let polling = false;
window.setInterval(async () => {
  if (polling || !worlds.some(world => world.status === "creating" || world.status === "pausing")) return;
  polling = true;
  try { await loadWorlds(); clearToast("world-poll"); syncWorlds(); }
  catch (error) { showToast(error, { key: "world-poll", onceUntilCleared: true }); }
  finally { polling = false; }
}, 750);
