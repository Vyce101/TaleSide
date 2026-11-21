import type { GenerationEvent, Message, Tale, TaleSearchResult, TaleSummary, World } from "../shared/types.js";
import { apiError, keySettings, loadTales, loadWorlds, newId, orderedTales, post, recentTime, removeTale,
  request, storeTale, storeWorld, taleRoute, tales, worlds } from "./data.js";
import { element } from "./dom.js";
import { closeKeyEditor, currentChatSettings, initializeSettings, refreshKeys, renderKeysView, renderWorldContext } from "./settings.js";
import { fillMessageText, formatDate, homeView, icon, idleView, messageRows, messageTurn, recentCollapsed, recentTaleRows, taleRows, taleView, type Icon } from "./view.js";
import { animateSurface, historyFrames, setSurfaceVisible, slideFrames } from "./motion.js";
import { clearToast, showToast } from "./toasts.js";
import { initializeTooltips } from "./tooltips.js";
import { handleWorldAction, hideWorldPanel, isWorldEditorOpen, leaveWorldSetup, openWorldEditor, restoreWorldPanel, syncWorldPanel } from "./world-editor.js";

type OpenTale = Tale & { draft?: boolean };
type Reply = { tale: OpenTale; id: string; controller: AbortController; assistant: Message; accepted: boolean; stopping: boolean; frame?: number };
let activeReply: Reply | undefined;
let navigation = 0;
const drafts = new Map<string, string>();

const workspace = element("workspace");
const workbench = element("workbench");
const drawers = {
  worlds: element("worlds-drawer"),
  settings: element("settings-drawer"),
  keys: element("keys-drawer"),
};
type Panel = keyof typeof drawers;
const panelNames = { worlds: "Worlds", settings: "Tale Settings", keys: "API Keys", "app-settings": "Settings" };
const narrow = matchMedia("(width < 1100px)");

export const state = {
  world: undefined as World | undefined,
  tale: undefined as OpenTale | undefined,
  panel: null as Panel | null,
  expanded: false,
  history: false,
};
const panelButtons = document.querySelectorAll<HTMLButtonElement>(".toolbar [data-panel]");

function keepReadingPosition(update: () => void) {
  const transcript = document.getElementById("transcript");
  if (!transcript || !transcript.clientHeight) {
    update();
    return;
  }

  const atEnd = transcript.scrollHeight > transcript.clientHeight
    && transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop < 3;
  if (atEnd) {
    update();
    transcript.scrollTop = transcript.scrollHeight;
    return;
  }

  const viewportTop = transcript.getBoundingClientRect().top;
  const turns = transcript.querySelectorAll(".turn");
  let first = 0;
  let last = turns.length;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    if (turns[middle].getBoundingClientRect().bottom > viewportTop) last = middle;
    else first = middle + 1;
  }
  const passage = Array.from(turns[first]?.querySelectorAll<HTMLElement>("[data-passage]") ?? [])
    .find(paragraph => paragraph.getBoundingClientRect().bottom > viewportTop);
  const bounds = passage?.getBoundingClientRect();
  const position = bounds ? (viewportTop - bounds.top) / Math.max(1, bounds.height) : 0;
  const scrollTop = transcript.scrollTop;

  update();
  if (passage && bounds && transcript.clientHeight) {
    const matchingPassage = passage.isConnected
      ? passage
      : transcript.querySelector(`[data-passage="${passage.dataset.passage}"]`);
    if (!matchingPassage) {
      transcript.scrollTop = scrollTop;
      return;
    }
    const resized = matchingPassage.getBoundingClientRect();
    const offset = position > 0 ? position * resized.height : position * bounds.height;
    transcript.scrollTop += resized.top + offset - transcript.getBoundingClientRect().top;
  } else {
    transcript.scrollTop = scrollTop;
  }
}

function updatePanelLayout() {
  const showFullWidth = narrow.matches && state.panel !== null && state.panel !== "keys";
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
  if (next && state.history) setHistory(false);

  if (previous) {
    setSurfaceVisible(drawers[previous], false, slideFrames, () => {
      if (previous === "worlds") hideWorldPanel();
      if (previous === "keys") closeKeyEditor();
      if (!next && !state.panel && returnFocus) element(`${previous}-button`).focus({ preventScroll: true });
    });
  }
  if (next) setSurfaceVisible(drawers[next], true, slideFrames);
  setPanelSide(next);
  updatePanelLayout();
  if (!next) return;

  if (next === "worlds") restoreWorldPanel();
  if (next === "keys") {
    renderKeysView();
    void refreshKeys().catch(error => showToast(error));
  }
  if (next === "settings") renderWorldContext();
  const drawer = drawers[next];
  drawer.querySelector(".panel-content")!.scrollTop = 0;
  drawer.querySelector<HTMLButtonElement>(".panel-back")!.focus({ preventScroll: true });
}

function renderMessages() {
  const { tale, world } = state;
  if (!tale || !world) return;
  const messages = element("messages");
  const openThoughts = new Set([...messages.querySelectorAll<HTMLDetailsElement>(".thinking-block[open]")]
    .map(block => block.dataset.thoughtFor));
  const focusedThought = document.activeElement?.closest<HTMLElement>(".thinking-block")?.dataset.thoughtFor;
  messages.innerHTML = messageRows(tale.messages, world);
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
  const reply = activeReply?.tale === tale ? activeReply : undefined;
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
  const settings = currentChatSettings();
  const canSend = settings?.chat_key_ids.length && world.retrieval_key_ids.some(id => keySettings.keys.some(key => key.id === id));
  const label = reply ? (reply.stopping ? "Stopping reply" : "Stop reply") : reason || "Send message";
  const shape = reply ? "stop" : reason && pendingIndex ? "spinner" : "send";
  if (button.dataset.shape !== shape) {
    button.dataset.shape = shape;
    button.innerHTML = shape === "spinner" ? '<span class="composer-spinner" aria-hidden="true"></span>' : icon(shape);
  }
  button.disabled = reply ? reply.stopping : waiting || !canSend;
  button.setAttribute("aria-label", label);
  button.dataset.tooltip = label;
}

function scrollToLatest() {
  const transcript = element("transcript");
  transcript.scrollTop = transcript.scrollHeight;
}

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
  const world = input.id === "world-tale-search" ? state.world : undefined;
  const list = element(world ? "history-list" : "recent-tales");
  const more = workspace.querySelector<HTMLButtonElement>('[data-action="expand-recent"]');
  const query = input.value.trim();
  if (more) more.hidden = !!query || tales.length <= recentCollapsed;
  if (!query) {
    list.removeAttribute("aria-busy");
    list.innerHTML = world ? taleRows(orderedTales(world), state.tale?.id)
      : recentTaleRows(orderedTales(), state.expanded, false);
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
      list.innerHTML = world && results.length ? taleRows(results, state.tale?.id)
        : recentTaleRows(results, state.expanded, true);
    } catch (error) {
      if (!controller.signal.aborted && input.isConnected) showToast(error, { key: "tale-search" });
    } finally {
      if (!controller.signal.aborted) list.removeAttribute("aria-busy");
    }
  };
  if (debounce) searchTimer = window.setTimeout(() => void search(), 175);
  else void search();
}

function renderWorkspace() {
  cancelTaleSearch();
  const { tale, world } = state;
  element("home-button").setAttribute("aria-current", String(!world));
  if (tale && world) {
    workspace.innerHTML = taleView(tale, world);
    element<HTMLTextAreaElement>("message-input").value = drafts.get(tale.id) ?? "";
    renderMessages();
    scrollToLatest();
  } else {
    workspace.innerHTML = idleView(homeView(orderedTales(), state.expanded));
    const input = element<HTMLInputElement>("home-tale-search");
    input.value = homeQuery;
    if (homeQuery.trim()) updateTaleSearch(input, false);
  }
}

function setWorkspace(world?: World, tale?: OpenTale) {
  if (activeReply && activeReply.tale.id !== tale?.id) stopReply(activeReply, true);
  state.world = world;
  state.tale = tale;
  state.history = false;
  renderWorkspace();
}

export function navigate(world?: World, tale?: OpenTale) {
  navigation++;
  showPanel(null, false);
  setWorkspace(world, tale);
  element("screen-title").focus({ preventScroll: true });
}

function latestTale(world: World) {
  return tales.filter(tale => tale.world_id === world.id).sort((a, b) => recentTime(b) - recentTime(a))[0];
}

function draftTale(world: World): OpenTale {
  const now = Date.now();
  const stamp = formatDate(now);
  return { id: newId(), world_id: world.id, title: `${world.name.slice(0, 97 - stamp.length)} - ${stamp}`,
    pinned: false, created_at: now / 1000, last_activity_at: null, message_count: 0, content: "", messages: [], draft: true };
}

async function openTale(world: World, tale: TaleSummary | undefined, inSidebar: boolean) {
  const revision = ++navigation;
  try {
    const selected = state.tale?.id === tale?.id && state.tale ? state.tale
      : tale ? await request<Tale>(taleRoute(tale)) : draftTale(world);
    if (navigation !== revision) return;
    const currentWorld = worlds.find(item => item.id === world.id) ?? world;
    if (inSidebar) {
      if (state.world?.id !== currentWorld.id || !state.tale) setWorkspace(currentWorld, selected);
      if (state.panel === "worlds") openWorldEditor(currentWorld);
    } else navigate(currentWorld, selected);
  } catch (error) { if (navigation === revision) showToast(error); }
}

export function enterWorld(world: World) {
  return openTale(world, latestTale(world), true);
}

function newTale() {
  if (!state.world?.can_play) return;
  navigate(state.world, draftTale(state.world));
  element("message-input").focus({ preventScroll: true });
}

function renderHistory() {
  updateTaleSearch(element<HTMLInputElement>("world-tale-search"), false);
}

function setHistory(show: boolean, returnFocus = false) {
  const toggle = workspace.querySelector<HTMLButtonElement>('[data-action="toggle-history"]');
  if (!toggle) return;
  if (show && state.panel) showPanel(null, false);
  if (show) renderHistory();
  else cancelTaleSearch();
  const history = element("tale-history");
  const transcript = element("transcript");
  const followingLatest = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop < 3;
  keepReadingPosition(() => {
    state.history = show;
    const motion = setSurfaceVisible(history, show, historyFrames);
    if (motion && followingLatest) followLatestDuringResize(transcript, motion);
    toggle.setAttribute("aria-expanded", String(show));
  });
  if (show) element("history-list").focus({ preventScroll: true });
  if (returnFocus) toggle.focus({ preventScroll: true });
}

function followLatestDuringResize(transcript: HTMLElement, motion: Animation) {
  let lastScrollTop = transcript.scrollTop;
  const observer = new ResizeObserver(() => {
    if (!transcript.isConnected || Math.abs(transcript.scrollTop - lastScrollTop) > 2) {
      observer.disconnect();
      return;
    }
    transcript.scrollTop = transcript.scrollHeight;
    lastScrollTop = transcript.scrollTop;
  });
  observer.observe(transcript);
  const stop = () => observer.disconnect();
  motion.finished.then(stop, stop);
}

function refreshTaleLists() {
  if (state.history) renderHistory();
  if (!state.tale) {
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

const taleDialog = element<HTMLDialogElement>("tale-dialog");
const taleName = element<HTMLInputElement>("tale-name");

type DialogOptions = { confirmLabel?: string; title: string; detail?: string; initialName?: string; nameLabel?: string; danger?: boolean };

export function previewDialog(options: DialogOptions, onConfirm: (name: string) => void | Promise<void>, restoreFocus?: () => void) {
  if (taleDialog.open) return;
  const hasName = options.initialName !== undefined;
  const confirm = element<HTMLButtonElement>("dialog-confirm");
  element("dialog-title").textContent = options.title;
  element("dialog-detail").textContent = options.detail ?? "";
  element("dialog-name-label").textContent = options.nameLabel ?? "Name";
  element("tale-name-field").hidden = !hasName;
  taleName.disabled = !hasName;
  taleName.required = hasName;
  taleName.value = options.initialName ?? "";
  taleName.setCustomValidity("");
  confirm.textContent = options.confirmLabel ?? (options.danger ? "Delete" : "Save");
  confirm.classList.toggle("danger-button", Boolean(options.danger));
  taleDialog.returnValue = "";
  taleDialog.addEventListener("close", async () => {
    if (taleDialog.returnValue === "confirm") await onConfirm(taleName.value.trim());
    restoreFocus?.();
  }, { once: true });
  taleDialog.showModal();
  const motion = animateSurface(taleDialog, [{ opacity: 0, translate: "0 -6px" }, { opacity: 1, translate: "0 0" }]);
  if (motion) motion.onfinish = () => motion.cancel();
  if (hasName) {
    taleName.focus();
    taleName.select();
  }
}


function editTale(action: "rename" | "delete", tale: TaleSummary, button: HTMLButtonElement) {
  const isRename = action === "rename";
  const options = isRename
    ? { title: "Rename Tale", initialName: tale.title, nameLabel: "Tale name" }
    : { title: "Delete Tale?", detail: `Permanently remove “${tale.title}” and its messages?`, danger: true };
  previewDialog(options, async name => {
    try {
      const open = tale.id === state.tale?.id ? state.tale : undefined;
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
        drafts.delete(tale.id);
        const world = state.world;
        if (open && world) {
          const latest = latestTale(world);
          if (latest) await openTale(world, latest, false);
          else navigate();
        } else refreshTaleLists();
      }
    } catch (error) { showToast(error); }
  }, () => restoreRowFocus(button));
}

function stopReply(reply: Reply, leaving = false) {
  reply.stopping = true;
  if (reply.accepted) {
    void post(`${taleRoute(reply.tale)}/stop`, { generation_id: reply.id, user_stopped: !leaving }, { keepalive: leaving })
      .catch(() => reply.controller.abort());
  }
  if (!reply.accepted || leaving) reply.controller.abort();
  if (leaving) {
    if (activeReply === reply) activeReply = undefined;
  }
  refreshComposer();
}

function updateReplyTurn(reply: Reply) {
  const assistant = reply.assistant;
  const world = state.world;
  if (!world) return;
  const messages = element("messages");
  const previous = messages.querySelector(`[data-message="${assistant.id}"]`);
  const template = document.createElement("template");
  template.innerHTML = messageTurn(assistant, world);
  fillMessageText(template.content, [assistant]);
  if (!previous) {
    messages.append(template.content);
    return;
  }

  const prose = previous.querySelector(".prose")!;
  const previousThought = previous.querySelector(".thinking-block");
  const nextThought = template.content.querySelector(".thinking-block");
  if (previousThought && nextThought) {
    const summary = previousThought.querySelector("summary")!;
    const nextSummary = nextThought.querySelector("summary")!;
    if (!summary.isEqualNode(nextSummary)) summary.replaceChildren(...nextSummary.childNodes);
    previousThought.querySelector(".thought-prose")!.replaceWith(nextThought.querySelector(".thought-prose")!);
  } else if (nextThought) prose.before(nextThought);
  else previousThought?.remove();
  prose.replaceWith(template.content.querySelector(".prose")!);

  previous.querySelector(".reply-error")?.remove();
  const error = template.content.querySelector(".reply-error");
  if (error) previous.querySelector(".turn-content")!.append(error);

  const time = template.content.querySelector(".reply-time");
  if (time && !previous.querySelector(".reply-time")) previous.querySelector(".turn-rail")!.append(time);
}

function renderReply(reply: Reply) {
  if (reply.frame !== undefined || state.tale !== reply.tale || activeReply !== reply) return;
  reply.frame = requestAnimationFrame(() => {
    reply.frame = undefined;
    if (state.tale === reply.tale && activeReply === reply) keepReadingPosition(() => updateReplyTurn(reply));
  });
}

async function readReply(response: Response, consume: (event: GenerationEvent) => void) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) if (line) consume(JSON.parse(line) as GenerationEvent);
    }
  } finally { await reader.cancel().catch(() => {}); }
}

async function sendOrStop() {
  const { tale, world } = state;
  if (!tale || !world) return;
  if (activeReply) { stopReply(activeReply); return; }
  const input = element<HTMLTextAreaElement>("message-input");
  const text = input.value.trim();
  const settings = currentChatSettings();
  if (!text || !settings || element<HTMLButtonElement>("send-message").disabled) return;
  const originalDraft = input.value;
  const assistant: Message = { id: -2, role: "assistant", content: "", thinking: "", model: settings.model,
    status: "generating", elapsed_ms: null, thinking_ms: null };
  const reply: Reply = { tale, id: newId(), controller: new AbortController(), assistant, accepted: false, stopping: false };
  activeReply = reply;
  input.value = "";
  drafts.delete(tale.id);
  tale.messages = tale.messages.filter(message => message.id >= 0);
  tale.messages.push({ id: -1, role: "user", content: text, thinking: "", model: null,
    status: "complete", elapsed_ms: null, thinking_ms: null }, assistant);
  renderMessages();
  scrollToLatest();
  try {
    const response = await post(`${taleRoute(tale)}/generate`,
      { generation_id: reply.id, content: text, title: tale.title, settings }, { signal: reply.controller.signal });
    if (!response.ok) throw await apiError(response);
    let finished = false;
    await readReply(response, event => {
      if (event.type === "accepted") {
        Object.assign(tale, event.tale, { draft: false });
        reply.accepted = true;
        reply.assistant = tale.messages.find(message => message.id === event.assistant.id)!;
        storeTale(event.tale);
        if (state.tale === tale && activeReply === reply) keepReadingPosition(renderMessages);
        if (reply.stopping && !reply.controller.signal.aborted) stopReply(reply);
      } else if (event.type === "done") {
        finished = true;
        Object.assign(reply.assistant, event.message);
      } else if (event.type === "thinking") {
        reply.assistant.thinking += event.text;
        reply.assistant.thinking_ms = event.thinking_ms;
      } else if (event.type === "reply") {
        reply.assistant.content += event.text;
      }
      renderReply(reply);
    });
    if (!finished) throw new Error("The connection closed before the reply finished.");
  } catch (error) {
    if (!reply.stopping && !reply.controller.signal.aborted) {
      if (reply.accepted) reply.assistant.error = error instanceof Error ? error.message : "The connection closed.";
      else showToast(error);
    }
    if (!reply.accepted) {
      tale.messages = tale.messages.filter(message => message.id !== -1);
      if (!drafts.has(tale.id)) drafts.set(tale.id, originalDraft);
      if (state.tale === tale && !input.value) input.value = originalDraft;
    }
  } finally {
    if (reply.assistant.status === "generating") reply.assistant.status = reply.stopping ? "stopped" : "error";
    if (reply.frame !== undefined) cancelAnimationFrame(reply.frame);
    if (activeReply === reply) {
      activeReply = undefined;
      if (state.tale === tale) {
        if (reply.accepted) {
          keepReadingPosition(() => updateReplyTurn(reply));
          refreshComposer();
        } else keepReadingPosition(renderMessages);
      }
    }
    if (reply.accepted || reply.controller.signal.aborted) {
      void loadTales().then(refreshTaleLists, error => showToast(error));
    }
  }
}

export function updateWorld(world: World) {
  storeWorld(world);
  syncWorlds();
}

let lastWorlds = new Map<string, World>();

export function syncWorlds() {
  for (const world of worlds) {
    const previous = lastWorlds.get(world.id);
    if (!previous || previous.status === world.status || isWorldEditorOpen(world.id)) continue;
    if (world.status === "failed") showToast(`${world.name}: ${world.error ?? "Indexing failed."}`);
    if (world.status === "ready" && ["creating", "pausing"].includes(previous.status)) {
      showToast(`${world.name} finished indexing.`, { success: true });
    }
  }
  lastWorlds = new Map(worlds.map(world => [world.id, world]));
  const worldNames = JSON.stringify(worlds.map(world => [world.id, world.name]).sort());
  if (searchedWorldNames !== worldNames) {
    searchedWorldNames = worldNames;
    const input = document.querySelector<HTMLInputElement>("#home-tale-search");
    if (input?.value.trim()) updateTaleSearch(input, false);
  }
  if (state.world) {
    const previous = state.world;
    const world = worlds.find(item => item.id === previous.id);
    if (world) {
      state.world = world;
      if (previous.name !== world.name || previous.artwork !== world.artwork) keepReadingPosition(renderMessages);
      refreshComposer();
    }
  }
  syncWorldPanel();
}

const taleDialogForm = element<HTMLFormElement>("tale-dialog-form");
let closingDialog = false;

function closeTaleDialog(value = "cancel") {
  if (!taleDialog.open || closingDialog) return;
  closingDialog = true;
  taleDialog.toggleAttribute("data-closing", true);
  const motion = animateSurface(taleDialog, [{ opacity: 1, translate: "0 0" }, { opacity: 0, translate: "0 -6px" }]);
  const close = () => {
    taleDialog.close(value);
    taleDialog.removeAttribute("data-closing");
    closingDialog = false;
    motion?.cancel();
  };
  if (motion) motion.onfinish = close;
  else close();
}

taleDialog.addEventListener("cancel", event => {
  event.preventDefault();
  closeTaleDialog();
});
taleDialog.addEventListener("click", event => {
  if (event.target !== taleDialog) return;
  if (!outside(event, taleDialog)) return;
  closeTaleDialog();
  if (state.panel && outside(event, drawers[state.panel])) showPanel(null);
  if (state.history && outside(event, element("tale-history"))) setHistory(false, true);
});

function outside({ clientX, clientY }: MouseEvent, surface: HTMLElement) {
  const { left, right, top, bottom } = surface.getBoundingClientRect();
  return clientX < left || clientX > right || clientY < top || clientY > bottom;
}
taleName.addEventListener("input", () => taleName.setCustomValidity(""));
element("dialog-cancel").addEventListener("click", () => closeTaleDialog());
taleDialogForm.addEventListener("submit", event => {
  event.preventDefault();
  if (!taleName.disabled && !taleName.value.trim()) {
    taleName.setCustomValidity("Enter a name.");
    taleName.reportValidity();
    return;
  }
  closeTaleDialog("confirm");
});

for (const button of panelButtons) {
  const name = button.dataset.panel as keyof typeof panelNames;
  const glyph: Icon = name === "keys" ? "key" : name === "app-settings" ? "gear" : name;
  button.innerHTML = icon(glyph);
  button.setAttribute("aria-label", panelNames[name]);
  button.dataset.tooltip = panelNames[name];
  if (name !== "app-settings") button.addEventListener("click", () => showPanel(state.panel === name ? null : name));
}

element("home-button").addEventListener("click", () => leaveWorldSetup(() => navigate()));
for (const drawer of Object.values(drawers)) {
  drawer.querySelector(".panel-back")!.addEventListener("click", () => showPanel(null));
}
document.addEventListener("click", event => {
  if ((!state.panel && !state.history) || !(event.target instanceof Element)
    || event.target.closest(".toolbar button, dialog[open], #toasts")) return;
  if (state.panel && drawers[state.panel].contains(event.target)) return;
  if (state.history && event.target.closest('#tale-history, [data-action="toggle-history"]')) return;
  const clickedControl = event.target.closest("button, a[href], input, select, textarea, label, summary, [tabindex], [contenteditable=true]");
  if (state.history) setHistory(false, !clickedControl);
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
  const tale = id && state.tale?.id === id ? state.tale : tales.find(entry => entry.id === id) ?? searchResults.find(entry => entry.id === id);
  switch (action) {
    case "open-world": {
      const world = worlds.find(entry => entry.id === id);
      if (world) void enterWorld(world);
      break;
    }
    case "open-tale": {
      const world = worlds.find(item => item.id === tale?.world_id);
      if (tale && world) leaveWorldSetup(() => { void openTale(world, tale, false); });
      break;
    }
    case "new-tale": newTale(); break;
    case "close-tale": navigate(); break;
    case "toggle-history": setHistory(!state.history); break;
    case "expand-recent":
      state.expanded = !state.expanded;
      renderWorkspace();
      if (state.expanded) workspace.querySelectorAll<HTMLButtonElement>(".tale-link")[recentCollapsed]?.focus();
      else restoreRowFocus(button);
      break;
    case "pin-tale":
      if (tale) {
        void request(`${taleRoute(tale)}/pin`, { pinned: !tale.pinned }).then(() => {
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
    default:
      handleWorldAction(action, id, button);
  }
});
workspace.addEventListener("submit", event => {
  if (!(event.target instanceof HTMLFormElement) || event.target.id !== "composer") return;
  event.preventDefault();
  void sendOrStop();
});

workspace.addEventListener("input", event => {
  const input = event.target;
  if (input instanceof HTMLInputElement && ["home-tale-search", "world-tale-search"].includes(input.id)) {
    if (input.id === "home-tale-search") homeQuery = input.value;
    updateTaleSearch(input);
  }
  if (state.tale && input instanceof HTMLTextAreaElement && input.id === "message-input") {
    drafts.set(state.tale.id, input.value);
  }
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
    if (state.panel) showPanel(null);
    else if (state.history) setHistory(false, true);
  }
  const input = event.target;
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing
    && input instanceof HTMLTextAreaElement && input.id === "message-input") {
    event.preventDefault();
    if (state.tale && !activeReply) void sendOrStop();
  }
});


window.addEventListener("pagehide", () => { if (activeReply) stopReply(activeReply, true); });
initializeTooltips();
renderWorkspace();
void Promise.all([loadWorlds(), loadTales(), initializeSettings(), refreshKeys()]).then(() => {
  syncWorlds();
  refreshTaleLists();
}).catch(error => showToast(error));

let polling = false;
window.setInterval(async () => {
  if (polling || !worlds.some(world => world.status === "creating" || world.status === "pausing")) return;
  polling = true;
  try { await loadWorlds(); clearToast("world-poll"); syncWorlds(); }
  catch (error) { showToast(error, { key: "world-poll", onceUntilCleared: true }); }
  finally { polling = false; }
}, 750);
