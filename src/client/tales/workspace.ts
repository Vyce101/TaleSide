import type { ChatSettings, Message, Persona, Tale, World } from "../../shared/types.js";
import { keySettings, newId, request, storeTale, taleRoute, type OpenTale } from "../data.js";
import { previewDialog } from "../dialog.js";
import { element } from "../dom.js";
import { refreshPromptCounts } from "../prompts.js";
import { showToast } from "../toasts.js";
import { fillMessageText, formatDate, icon, messageRows, taleView } from "../view.js";
import { keepReadingPosition, scrollToLatest } from "./reading-position.js";
import { createTaleReply } from "./reply.js";

const DRAFT_OPENING_MESSAGE_ID = -3;

type WorkspaceOptions = {
  workspace: HTMLElement;
  currentChatSettings: () => ChatSettings | undefined;
  currentPersona: () => Persona | undefined;
  onBranch: (world: World, tale: Tale) => void;
  onTalesChanged: () => void;
};

export function createTaleWorkspace({ workspace, currentChatSettings, currentPersona, onBranch, onTalesChanged }: WorkspaceOptions) {
  const selection: { world?: World; tale?: OpenTale } = {};
  let turnPending = false;
  let editingTurn = false;
  let warnSignatures = true;
  const drafts = new Map<string, string>();
  const clearDraft = (id: string) => { drafts.delete(id); };
  const reply = createTaleReply({
    currentTale: () => selection.tale, currentWorld: () => selection.world, currentChatSettings, currentPersona,
    isTurnBusy: () => turnPending || editingTurn, warnMissingKeys, clearDraft,
    restoreDraft: (id, draft) => { if (!drafts.has(id)) drafts.set(id, draft); },
    renderMessages, refreshComposer, onTalesChanged,
  });

  function select(world?: World, tale?: OpenTale) {
    if (reply.active && reply.active.tale.id !== tale?.id) reply.leave();
    editingTurn = false;
    selection.world = world;
    selection.tale = tale;
    refreshPromptCounts(tale?.prompt_counts);
  }

  function render() {
    const { tale, world } = selection;
    if (!tale || !world) return;
    workspace.innerHTML = taleView(tale, world);
    element<HTMLTextAreaElement>("message-input").value = drafts.get(tale.id) ?? "";
    renderMessages();
    scrollToLatest();
  }

  function syncWorld(world: World) {
    const previous = selection.world;
    if (!previous) return;
    selection.world = world;
    const tale = selection.tale;
    if (tale?.draft && !reply.active && JSON.stringify(previous.openings) !== JSON.stringify(world.openings)) {
      tale.messages = draftOpening(world, tale.messages[0]);
      keepReadingPosition(renderMessages);
    } else if (previous.name !== world.name || previous.artwork !== world.artwork) keepReadingPosition(renderMessages);
    refreshComposer();
  }

  function renderMessages() {
    const { tale, world } = selection;
    if (!tale || !world || (editingTurn && document.querySelector(".turn-editor"))) return;
    const messages = element("messages");
    const openThoughts = new Set([...messages.querySelectorAll<HTMLDetailsElement>(".thinking-block[open]")]
      .map(block => block.dataset.thoughtFor));
    const focusedThought = document.activeElement?.closest<HTMLElement>(".thinking-block")?.dataset.thoughtFor;
    messages.innerHTML = messageRows(tale.messages, world, !!reply.active || turnPending || editingTurn, tale.draft);
    fillMessageText(messages, tale.messages);
    for (const thought of messages.querySelectorAll<HTMLDetailsElement>(".thinking-block")) {
      thought.open = openThoughts.has(thought.dataset.thoughtFor);
      if (focusedThought === thought.dataset.thoughtFor) thought.querySelector("summary")?.focus({ preventScroll: true });
    }
    refreshComposer();
  }

  function refreshComposer() {
    const { tale, world } = selection;
    const composer = document.getElementById("composer");
    if (!composer || !tale || !world) return;
    const button = element<HTMLButtonElement>("send-message");
    const input = element<HTMLTextAreaElement>("message-input");
    const next = workspace.querySelector<HTMLButtonElement>('[data-action="new-tale"]');
    if (next) next.disabled = !world.can_play;
    const activeReply = reply.active?.tale === tale ? reply.active : undefined;
    const waiting = !world.can_play;
    const pendingIndex = ["creating", "pausing"].includes(world.status);
    let reason = "";
    if (waiting) {
      if (pendingIndex) reason = "Waiting for the first indexed passage";
      else if (world.status === "unindexed") reason = "Start indexing in Worlds to send a message";
      else reason = "Resume indexing in Worlds to send a message";
    }
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
    let label = reason || "Send message";
    let shape: "send" | "spinner" | "stop" = waiting && pendingIndex ? "spinner" : "send";
    if (activeReply) {
      label = activeReply.stopping ? "Stopping reply" : "Stop reply";
      shape = "stop";
    }
    if (button.dataset.shape !== shape) {
      button.dataset.shape = shape;
      button.innerHTML = shape === "spinner" ? '<span class="composer-spinner" aria-hidden="true"></span>' : icon(shape);
    }
    button.disabled = activeReply ? activeReply.stopping : waiting || turnPending || editingTurn;
    button.setAttribute("aria-label", label);
    button.dataset.tooltip = label;
  }

  function warnMissingKeys(world: World, settings = currentChatSettings()) {
    if (!settings) return true;
    const missingChat = settings.chat_key_ids.length === 0;
    const missingRetrieval = settings.prompts.some(block => block.kind === "retrieved_passages" && block.enabled)
      && !world.retrieval_key_ids.some(id => keySettings.keys.some(key => key.id === id));
    if (missingRetrieval) showToast(`Select a retrieval key for “${world.name}” in Tale Settings.`);
    if (missingChat) showToast("Select a chat key in Tale Settings.");
    return missingRetrieval || missingChat;
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
      if (selection.tale === tale) {
        if (action === "branch") onBranch(selection.world!, updated);
        else Object.assign(tale, updated);
      }
      onTalesChanged();
      return true;
    } catch (error) {
      if (selection.tale === tale) turnError(message.id, error);
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
      if (selection.tale === tale) finish();
    });
    text.focus({ preventScroll: true });
  }

  async function handleTurn(button: HTMLButtonElement) {
    const tale = selection.tale;
    const article = button.closest<HTMLElement>(".turn");
    const message = tale?.messages.find(row => row.id === Number(article?.dataset.message));
    if (!tale || !article || !message || reply.active || turnPending || editingTurn) return;
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
    if (action === "regenerate-turn") { await reply.sendOrStop({ message, mode: message.role === "user" ? "answer" : "regenerate" }); return; }
    if (action === "delete-turn") {
      const below = tale.messages.length - tale.messages.indexOf(message) - 1;
      const multi = below === 0 && (message.swipes?.length ?? 0) > 1;
      const remove = async (mode: string) => {
        if (!await changeTurn(tale, message, "delete-message", { mode })) return;
        if (selection.tale === tale) { keepReadingPosition(renderMessages); focusTurn(message.id, action); }
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
      await reply.sendOrStop({ message, mode: "swipe" });
      return;
    }
    const selected = (position + count) % count;
    const keyboardSwipe = button === document.activeElement && button.matches(":focus-visible");
    const transcript = element("transcript");
    const offset = transcript.scrollTop;
    if (tale.draft && message.swipes) Object.assign(message, message.swipes[selected], { swipe: selected });
    else if (!await changeTurn(tale, message, "select-swipe", { position: selected })) return;
    if (selection.tale !== tale) return;
    renderMessages();
    transcript.scrollTop = offset;
    if (keyboardSwipe) focusTurn(message.id, action);
  }

  function initialize() {
    workspace.addEventListener("submit", event => {
      if (!(event.target instanceof HTMLFormElement) || event.target.id !== "composer") return;
      event.preventDefault();
      void reply.sendOrStop();
    });
    workspace.addEventListener("input", event => {
      const input = event.target;
      if (selection.tale && input instanceof HTMLTextAreaElement && input.id === "message-input") {
        drafts.set(selection.tale.id, input.value);
      }
    });
    document.addEventListener("keydown", event => {
      const input = event.target;
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing
        && input instanceof HTMLTextAreaElement && input.id === "message-input") {
        event.preventDefault();
        if (selection.tale && !reply.active) void reply.sendOrStop();
      }
    });
    window.addEventListener("pagehide", reply.leave);
    const warning = element<HTMLInputElement>("warn-signatures");
    warning.addEventListener("change", () => setSignatureWarning(warning.checked, warning));
    void request<{ warn_signatures: boolean }>("/api/app-settings").then(saved => {
      warnSignatures = saved.warn_signatures;
      warning.checked = warnSignatures;
    }).catch(error => { element("app-settings-error").textContent = String(error); });
  }

  return {
    get world() { return selection.world; },
    get tale() { return selection.tale; },
    initialize, select, render, syncWorld, refreshComposer, handleTurn, warnMissingKeys, clearDraft,
  };
}

function draftOpening(world: World, previous?: Message): Message[] {
  const openings = world.openings.filter(text => text.trim()).map(content => ({
    content, thinking: "", model: null, status: "complete" as const, elapsed_ms: null, thinking_ms: null,
  }));
  if (!openings.length) return [];
  const previousText = openings.findIndex(opening => opening.content === previous?.content);
  const swipe = previousText >= 0 ? previousText : Math.min(previous?.swipe ?? 0, openings.length - 1);
  return [{ ...openings[swipe], id: DRAFT_OPENING_MESSAGE_ID, role: "assistant", opening: true, swipe, swipes: openings }];
}

export function draftTale(world: World): OpenTale {
  const now = Date.now();
  const stamp = formatDate(now);
  return { id: newId(), world_id: world.id, title: `${world.name.slice(0, 97 - stamp.length)} - ${stamp}`,
    pinned: false, created_at: now / 1000, last_activity_at: null, message_count: 0, content: "", messages: draftOpening(world), draft: true };
}
