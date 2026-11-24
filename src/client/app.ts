import { createTaleReply } from "./tales/reply.js";
import { createTaleLists, latestTale } from "./tales/lists.js";
import { createKeysPanel } from "./keys-panel.js";
import { keepReadingPosition, scrollToLatest } from "./tales/reading-position.js";
import { initializeDialog, outside, previewDialog } from "./dialog.js";
import { refreshPromptCounts } from "./prompts.js";
import { createPersonaPanel } from "./personas.js";
import type { Message, Tale, TaleSummary, World } from "../shared/types.js";
import { keySettings, loadTales, loadWorlds, newId,
  request, storeTale, storeWorld, taleRoute, worlds } from "./data.js";
import { element } from "./dom.js";
import { createTaleSettings } from "./tales/settings.js";
import { fillMessageText, formatDate, icon, messageRows, taleView, type Icon } from "./view.js";
import { setSurfaceVisible, slideFrames } from "./motion.js";
import { clearToast, showToast } from "./toasts.js";
import { initializeTooltips } from "./tooltips.js";
import { createWorldEditor } from "./worlds/editor.js";

type OpenTale = Tale & { draft?: boolean };
let navigation = 0;
let turnPending = false;
let editingTurn = false;
let warnSignatures = true;
const drafts = new Map<string, string>();

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

export const state = {
  world: undefined as World | undefined,
  tale: undefined as OpenTale | undefined,
  panel: null as Panel | null,
};
const panelButtons = document.querySelectorAll<HTMLButtonElement>(".toolbar [data-panel]");

const taleLists = createTaleLists({
  workspace,
  currentWorld: () => state.world,
  currentTale: () => state.tale,
  closeDrawer: () => showPanel(null, false),
  openTale: (world, tale) => openTale(world, tale, false),
  openListedTale: (world, tale) => worldEditor.leaveWorldSetup(() => { void openTale(world, tale, false); }),
  goHome: () => navigate(),
  forgetDraft: id => { drafts.delete(id); },
});
export const worldEditor = createWorldEditor({
  currentWorld: () => state.world,
  isOpen: () => state.panel === "worlds",
  showWorldPanel: () => showPanel("worlds", false),
  enterWorld,
  goHome: () => navigate(),
  onWorldUpdated: updateWorld,
});

const personas = createPersonaPanel({
  currentWorld: () => state.world,
  currentTale: () => state.tale,
  isOpen: () => state.panel === "personas",
});

const taleSettings = createTaleSettings({
  currentWorld: () => state.world,
  onWorldUpdated: updateWorld,
  onChatSettingsChanged: refreshComposer,
});

const keysPanel = createKeysPanel({
  isOpen: () => state.panel === "keys",
  onKeysChanged: () => {
    taleSettings.renderChatKey();
    if (state.panel === "settings") taleSettings.renderWorldContext();
    worldEditor.updateWorldEditorKeys();
    refreshComposer();
  },
  onWorldsReloaded: syncWorlds,
});

const taleReply = createTaleReply({
  currentTale: () => state.tale,
  currentWorld: () => state.world,
  currentChatSettings: taleSettings.currentChatSettings,
  currentPersona: personas.currentPersona,
  isTurnBusy: () => turnPending || editingTurn,
  warnMissingKeys,
  clearDraft: id => { drafts.delete(id); },
  restoreDraft: (id, draft) => { if (!drafts.has(id)) drafts.set(id, draft); },
  renderMessages,
  refreshComposer,
  onTalesChanged: taleLists.refreshTaleLists,
});

function updatePanelLayout() {
  const showFullWidth = narrow.matches && state.panel !== null && state.panel !== "keys" && state.panel !== "personas" && state.panel !== "app-settings";
  workspace.inert = showFullWidth;
  if (!state.panel) return;
  const back = drawers[state.panel].querySelector<HTMLButtonElement>(".panel-back")!;
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

export function showPanel(next: Panel | null, returnFocus = true) {
  const previous = state.panel;
  if (previous === next) return;
  state.panel = next;
  for (const button of panelButtons) {
    if (!button.disabled) button.setAttribute("aria-expanded", String(button.dataset.panel === next));
  }
  if (next && taleLists.historyOpen) taleLists.setHistory(false);

  if (previous) {
    setSurfaceVisible(drawers[previous], false, slideFrames, () => {
      if (previous === "worlds") worldEditor.hideWorldPanel();
      if (previous === "keys") keysPanel.closeKeyEditor();
      if (!next && !state.panel && returnFocus) element(`${previous}-button`).focus({ preventScroll: true });
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

function renderMessages() {
  const { tale, world } = state;
  if (!tale || !world || (editingTurn && document.querySelector(".turn-editor"))) return;
  const messages = element("messages");
  const openThoughts = new Set([...messages.querySelectorAll<HTMLDetailsElement>(".thinking-block[open]")]
    .map(block => block.dataset.thoughtFor));
  const focusedThought = document.activeElement?.closest<HTMLElement>(".thinking-block")?.dataset.thoughtFor;
  messages.innerHTML = messageRows(tale.messages, world, !!taleReply.active || turnPending || editingTurn, tale.draft);
  fillMessageText(messages, tale.messages);
  for (const thought of messages.querySelectorAll<HTMLDetailsElement>(".thinking-block")) {
    thought.open = openThoughts.has(thought.dataset.thoughtFor);
    if (focusedThought === thought.dataset.thoughtFor) thought.querySelector("summary")?.focus({ preventScroll: true });
  }
  refreshComposer();
}

export function refreshComposer() {
  const { tale, world } = state;
  const composer = document.getElementById("composer");
  if (!composer || !tale || !world) return;
  const button = element<HTMLButtonElement>("send-message");
  const input = element<HTMLTextAreaElement>("message-input");
  const next = workspace.querySelector<HTMLButtonElement>('[data-action="new-tale"]');
  if (next) next.disabled = !world.can_play;
  const reply = taleReply.active?.tale === tale ? taleReply.active : undefined;
  const waiting = !world.can_play;
  const pendingIndex = ["creating", "pausing"].includes(world.status);
  const reason = waiting
    ? pendingIndex ? "Waiting for the first indexed passage"
      : world.status === "unindexed" ? "Start indexing in Worlds to send a message" : "Resume indexing in Worlds to send a message"
    : "";
  input.disabled = waiting;
  const placeholder = reason || "Type a message";
  input.placeholder = placeholder;
  composer.querySelector(".composer-placeholder")!.textContent = placeholder;
  composer.toggleAttribute("data-waiting", waiting);
  if (reason) {
    composer.dataset.tooltip = reason;
    composer.setAttribute("aria-label", reason);
    composer.tabIndex = 0;
  } else {
    delete composer.dataset.tooltip;
    composer.removeAttribute("aria-label");
    composer.removeAttribute("tabindex");
  }
  const label = reply ? (reply.stopping ? "Stopping reply" : "Stop reply") : reason || "Send message";
  const shape = reply ? "stop" : reason && pendingIndex ? "spinner" : "send";
  if (button.dataset.shape !== shape) {
    button.dataset.shape = shape;
    button.innerHTML = shape === "spinner" ? '<span class="composer-spinner" aria-hidden="true"></span>' : icon(shape);
  }
  button.disabled = reply ? reply.stopping : waiting || turnPending || editingTurn;
  button.setAttribute("aria-label", label);
  button.dataset.tooltip = label;
}

function renderWorkspace() {
  taleLists.reset();
  const { tale, world } = state;
  element("home-button").setAttribute("aria-current", String(!world));
  if (tale && world) {
    workspace.innerHTML = taleView(tale, world);
    element<HTMLTextAreaElement>("message-input").value = drafts.get(tale.id) ?? "";
    renderMessages();
    scrollToLatest();
  } else taleLists.showHome();
}

function setWorkspace(world?: World, tale?: OpenTale) {
  if (taleReply.active && taleReply.active.tale.id !== tale?.id) taleReply.leave();
  editingTurn = false;
  state.world = world;
  state.tale = tale;
  refreshPromptCounts(tale?.prompt_counts);
  if (world) void personas.refreshPersonas();
  renderWorkspace();
}

export function navigate(world?: World, tale?: OpenTale) {
  navigation++;
  showPanel(null, false);
  setWorkspace(world, tale);
  element("screen-title").focus({ preventScroll: true });
}

function draftOpening(world: World, previous?: Message): Message[] {
  const openings = world.openings.filter(text => text.trim()).map(content => ({
    content, thinking: "", model: null, status: "complete" as const, elapsed_ms: null, thinking_ms: null,
  }));
  if (!openings.length) return [];
  const previousText = openings.findIndex(opening => opening.content === previous?.content);
  const swipe = previousText >= 0 ? previousText : Math.min(previous?.swipe ?? 0, openings.length - 1);
  return [{ ...openings[swipe], id: -3, role: "assistant", opening: true, swipe, swipes: openings }];
}

function draftTale(world: World): OpenTale {
  const now = Date.now();
  const stamp = formatDate(now);
  return { id: newId(), world_id: world.id, title: `${world.name.slice(0, 97 - stamp.length)} - ${stamp}`,
    pinned: false, created_at: now / 1000, last_activity_at: null, message_count: 0, content: "", messages: draftOpening(world), draft: true };
}

async function openTale(world: World, tale: TaleSummary | undefined, inSidebar: boolean) {
  const revision = ++navigation;
  try {
    const selected = state.tale?.id === tale?.id && state.tale ? state.tale
      : tale ? await request<Tale>(taleRoute(tale)) : draftTale(world);
    if (navigation !== revision) return;
    const currentWorld = worlds.find(item => item.id === world.id) ?? world;
    warnMissingKeys(currentWorld);
    if (inSidebar) {
      if (state.world?.id !== currentWorld.id || !state.tale) setWorkspace(currentWorld, selected);
      if (state.panel === "worlds") worldEditor.openWorldEditor(currentWorld);
    } else navigate(currentWorld, selected);
  } catch (error) { if (navigation === revision) showToast(error); }
}

function warnMissingKeys(world: World, settings = taleSettings.currentChatSettings()) {
  if (!settings) return true;
  const missingChat = settings.chat_key_ids.length === 0;
  const missingRetrieval = settings.prompts.some(block => block.kind === "retrieved_passages" && block.enabled)
    && !world.retrieval_key_ids.some(id => keySettings.keys.some(key => key.id === id));
  if (missingRetrieval) showToast(`Select a retrieval key for “${world.name}” in Tale Settings.`);
  if (missingChat) showToast("Select a chat key in Tale Settings.");
  return missingRetrieval || missingChat;
}

export function enterWorld(world: World) {
  return openTale(world, latestTale(world), true);
}

function newTale() {
  if (!state.world?.can_play) return;
  navigate(state.world, draftTale(state.world));
  element("message-input").focus({ preventScroll: true });
}

function setSignatureWarning(value: boolean, checkbox = element<HTMLInputElement>("warn-signatures")) {
  const previous = warnSignatures;
  warnSignatures = value;
  checkbox.checked = value;
  void request("/api/app-settings", { warn_signatures: value }).catch(error => {
    warnSignatures = previous;
    checkbox.checked = previous;
    element("app-settings-error").textContent = error instanceof Error ? error.message : String(error);
  });
}

function turnError(message: number, error: unknown) {
  const target = document.querySelector(`[data-message="${message}"] .turn-content`);
  if (!target) return;
  let spot = target.querySelector(".turn-action-error");
  if (!spot) {
    spot = document.createElement("p");
    spot.className = "inline-error turn-action-error";
    spot.setAttribute("role", "alert");
    target.append(spot);
  }
  spot.textContent = error instanceof Error ? error.message : String(error);
}

function focusTurn(message: number, action: string) {
  const article = document.querySelector<HTMLElement>(`[data-message="${message}"]`);
  const control = article?.querySelector<HTMLButtonElement>(`[data-action="${action}"]:enabled`);
  (control ?? article?.querySelector<HTMLButtonElement>(".swipe-right button:enabled") ?? article?.querySelector<HTMLButtonElement>(".turn-actions button:enabled")
    ?? element("message-input")).focus({ preventScroll: true });
}

async function changeTurn(tale: OpenTale, message: Message, action: string, details: object = {}) {
  turnPending = true;
  refreshComposer();
  try {
    const updated = await request<Tale>(`${taleRoute(tale)}/${action}`, { message_id: message.id, swipe: message.swipe ?? 0, ...details });
    storeTale(updated);
    if (state.tale === tale) {
      if (action === "branch") navigate(state.world, updated);
      else Object.assign(tale, updated);
    }
    taleLists.refreshTaleLists();
    return true;
  } catch (error) {
    if (state.tale === tale) turnError(message.id, error);
    return false;
  } finally {
    turnPending = false;
    refreshComposer();
  }
}

function editTurn(tale: OpenTale, message: Message) {
  editingTurn = true;
  keepReadingPosition(renderMessages);
  const article = document.querySelector(`[data-message="${message.id}"]`)!;
  const form = document.createElement("form");
  form.className = "turn-editor";
  form.id = "inline-turn-editor";
  form.innerHTML = '<textarea aria-label="Edit message" required></textarea>';
  const actions = article.querySelector<HTMLElement>(".turn-actions")!;
  actions.classList.add("turn-edit-actions");
  actions.innerHTML = `<button type="button" class="quiet-button">Cancel</button>
    <button type="submit" form="${form.id}" class="primary-button">Save</button>`;
  const text = form.querySelector("textarea")!;
  text.value = message.content;
  const initialText = text.value;
  const prose = article.querySelector<HTMLElement>(".prose")!;
  const proseHeight = prose.getBoundingClientRect().height;
  prose.replaceWith(form);
  const style = getComputedStyle(text);
  const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  text.style.height = Math.max(proseHeight, parseFloat(style.lineHeight)) + padding + borders + "px";
  const finish = () => {
    editingTurn = false;
    keepReadingPosition(renderMessages);
    focusTurn(message.id, "edit-turn");
  };
  actions.querySelector("button")!.onclick = () => { if (!turnPending) finish(); };
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (turnPending) return;
    if (text.value.trim() === initialText.trim()) { finish(); return; }
    if (!await changeTurn(tale, message, "edit-message", { content: text.value })) return;
    if (state.tale === tale) finish();
  });
  text.focus({ preventScroll: true });
}

async function handleTurn(button: HTMLButtonElement) {
  const tale = state.tale;
  const article = button.closest<HTMLElement>(".turn");
  const message = tale?.messages.find(row => row.id === Number(article?.dataset.message));
  if (!tale || !article || !message || taleReply.active || turnPending || editingTurn) return;
  const action = button.dataset.action!;
  if (action === "edit-turn") {
    if (message.has_signature && warnSignatures) previewDialog({
      title: "Edit this AI reply?",
      detail: "Saving changes clears the reply’s Gemini thinking signature for future messages.",
      confirmLabel: "Edit",
      checkbox: "Don’t show again",
    }, (_, suppressWarning) => {
      if (suppressWarning) setSignatureWarning(false);
      editTurn(tale, message);
    }, () => { if (!editingTurn) focusTurn(message.id, action); });
    else editTurn(tale, message);
    return;
  }
  if (action === "branch-turn") { await changeTurn(tale, message, "branch"); return; }
  if (action === "regenerate-turn") { await taleReply.sendOrStop({ message, mode: message.role === "user" ? "answer" : "regenerate" }); return; }
  if (action === "delete-turn") {
    const below = tale.messages.length - tale.messages.indexOf(message) - 1;
    const multi = below === 0 && (message.swipes?.length ?? 0) > 1;
    const remove = async (mode: string) => {
      if (!await changeTurn(tale, message, "delete-message", { mode })) return;
      if (state.tale === tale) { keepReadingPosition(renderMessages); focusTurn(message.id, action); }
    };
    previewDialog({ title: multi ? "Delete swipe?" : "Delete message?", danger: true,
      detail: multi ? "Permanently remove this swipe from the Tale." : "Permanently remove this message from the Tale.",
      checkbox: below ? `Delete the ${below} ${below === 1 ? "response" : "responses"} below this response`
        : multi ? "Delete the entire message" : undefined,
    }, (_, checked) => remove(below && checked ? "rewind" : multi && !checked ? "swipe" : "message"),
    () => focusTurn(message.id, action));
    return;
  }
  if (action !== "previous-swipe" && action !== "next-swipe") return;

  const count = message.swipes?.length ?? 1;
  const position = (message.swipe ?? 0) + (action === "previous-swipe" ? -1 : 1);
  if (position >= count && !message.opening) {
    await taleReply.sendOrStop({ message, mode: "swipe" });
    return;
  }
  const selected = (position + count) % count;
  const keyboardSwipe = button === document.activeElement && button.matches(":focus-visible");
  const transcript = element("transcript");
  const offset = transcript.scrollTop;
  if (tale.draft && message.swipes) Object.assign(message, message.swipes[selected], { swipe: selected });
  else if (!await changeTurn(tale, message, "select-swipe", { position: selected })) return;
  if (state.tale !== tale) return;
  renderMessages();
  transcript.scrollTop = offset;
  if (keyboardSwipe) focusTurn(message.id, action);
}

export function updateWorld(world: World) {
  storeWorld(world);
  syncWorlds();
}

let lastWorlds = new Map<string, World>();

export function syncWorlds() {
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
  if (state.world) {
    const previous = state.world;
    const world = worlds.find(item => item.id === previous.id);
    if (world) {
      state.world = world;
      const tale = state.tale;
      if (tale?.draft && !taleReply.active && JSON.stringify(previous.openings) !== JSON.stringify(world.openings)) {
        tale.messages = draftOpening(world, tale.messages[0]);
        keepReadingPosition(renderMessages);
      } else if (previous.name !== world.name || previous.artwork !== world.artwork) keepReadingPosition(renderMessages);
      refreshComposer();
    }
  }
  worldEditor.syncWorldPanel();
}

initializeDialog(event => {
  if (state.panel && outside(event, drawers[state.panel])) showPanel(null);
  if (taleLists.historyOpen && outside(event, element("tale-history"))) taleLists.setHistory(false, true);
});

for (const button of panelButtons) {
  const name = button.dataset.panel as keyof typeof panelNames;
  const glyph: Icon = name === "keys" ? "key" : name === "app-settings" ? "gear" : name === "inspector" ? "search" : name;
  button.innerHTML = icon(glyph);
  button.setAttribute("aria-label", panelNames[name]);
  button.dataset.tooltip = panelNames[name];
  if (name !== "inspector") button.addEventListener("click", () => showPanel(state.panel === name ? null : name));
}

element("home-button").addEventListener("click", () => worldEditor.leaveWorldSetup(() => navigate()));
for (const drawer of Object.values(drawers)) {
  drawer.querySelector(".panel-back")!.addEventListener("click", () => showPanel(null));
}
document.addEventListener("click", event => {
  if ((!state.panel && !taleLists.historyOpen) || !(event.target instanceof Element)
    || event.target.closest(".toolbar button, dialog[open], #toasts")) return;
  if (state.panel && drawers[state.panel].contains(event.target)) return;
  if (taleLists.historyOpen && event.target.closest('#tale-history, [data-action="toggle-history"]')) return;
  const clickedControl = event.target.closest("button, a[href], input, select, textarea, label, summary, [tabindex], [contenteditable=true]");
  if (taleLists.historyOpen) taleLists.setHistory(false, !clickedControl);
  else showPanel(null, !clickedControl);
}, { capture: true });
narrow.addEventListener("change", () => {
  const focusInWorkspace = workspace.contains(document.activeElement);
  updatePanelLayout();
  if (workspace.inert && focusInWorkspace && state.panel) {
    drawers[state.panel].querySelector<HTMLButtonElement>(".panel-back")!.focus({ preventScroll: true });
  }
});


document.addEventListener("click", event => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (button.closest(".turn")) { void handleTurn(button); return; }
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

workspace.addEventListener("submit", event => {
  if (!(event.target instanceof HTMLFormElement) || event.target.id !== "composer") return;
  event.preventDefault();
  void taleReply.sendOrStop();
});

workspace.addEventListener("input", event => {
  const input = event.target;
  if (state.tale && input instanceof HTMLTextAreaElement && input.id === "message-input") {
    drafts.set(state.tale.id, input.value);
  }
});

document.addEventListener("wheel", event => {
  if (event.ctrlKey || !event.deltaY || state.panel === "worlds" || state.panel === "settings"
    || document.querySelector("dialog[open]")) return;
  const origin = event.target;
  if (!(origin instanceof Element) || origin.closest("textarea, select, #toasts")) return;
  const scroller = state.panel ? drawers[state.panel].querySelector<HTMLElement>(".panel-content")
    : taleLists.historyOpen ? document.getElementById("history-list")
    : document.getElementById("transcript") ?? workspace.querySelector<HTMLElement>(".home-view");
  if (!scroller || scroller.contains(origin) || scroller.scrollHeight <= scroller.clientHeight) return;
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? scroller.clientHeight : 1;
  event.preventDefault();
  scroller.scrollTop += event.deltaY * unit;
}, { passive: false });

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
    if (state.panel) showPanel(null);
    else if (taleLists.historyOpen) taleLists.setHistory(false, true);
  }
  const input = event.target;
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing
    && input instanceof HTMLTextAreaElement && input.id === "message-input") {
    event.preventDefault();
    if (state.tale && !taleReply.active) void taleReply.sendOrStop();
  }
});


window.addEventListener("pagehide", taleReply.leave);
initializeTooltips();
keysPanel.initialize();
taleLists.initialize();
const warning = element<HTMLInputElement>("warn-signatures");
warning.addEventListener("change", () => setSignatureWarning(warning.checked, warning));
void request<{ warn_signatures: boolean }>("/api/app-settings").then(saved => {
  warnSignatures = saved.warn_signatures;
  warning.checked = warnSignatures;
}).catch(error => { element("app-settings-error").textContent = String(error); });
renderWorkspace();
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
