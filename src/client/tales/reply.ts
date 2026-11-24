import type { ChatSettings, GenerationEvent, Message, Persona, Swipe, World } from "../../shared/types.js";
import { apiError, loadTales, newId, post, storeTale, taleRoute, type OpenTale } from "../data.js";
import { element } from "../dom.js";
import { refreshPromptCounts } from "../prompts.js";
import { showToast } from "../toasts.js";
import { fillMessageText, formatDuration, messageTurn } from "../view.js";
import { keepReadingPosition } from "./reading-position.js";

const PENDING_USER_MESSAGE_ID = -1;
const PENDING_ASSISTANT_MESSAGE_ID = -2;
const REPLY_CLOCK_INTERVAL_MS = 250;

type Reply = {
  tale: OpenTale;
  generationId: string;
  controller: AbortController;
  assistant: Message;
  accepted: boolean;
  stopping: boolean;
  startedAtMs: number;
  clockTimer?: number;
  renderFrame?: number;
};
type ReplyTarget = { message: Message; mode: "regenerate" | "swipe" | "answer" };

type ReplyOptions = {
  currentTale: () => OpenTale | undefined;
  currentWorld: () => World | undefined;
  currentChatSettings: () => ChatSettings | undefined;
  currentPersona: () => Persona | undefined;
  isTurnBusy: () => boolean;
  warnMissingKeys: (world: World, settings: ChatSettings) => boolean;
  clearDraft: (id: string) => void;
  restoreDraft: (id: string, draft: string) => void;
  renderMessages: () => void;
  refreshComposer: () => void;
  onTalesChanged: () => void;
};

export function createTaleReply({ currentTale, currentWorld, currentChatSettings, currentPersona, isTurnBusy,
  warnMissingKeys, clearDraft, restoreDraft, renderMessages, refreshComposer, onTalesChanged }: ReplyOptions) {
  let activeReply: Reply | undefined;

  function stopReply(reply: Reply, reason: "user" | "leave" = "user") {
    const leavingTale = reason === "leave";
    reply.stopping = true;
    if (leavingTale) window.clearInterval(reply.clockTimer);
    if (reply.accepted) {
      void post(`${taleRoute(reply.tale)}/stop`, { generation_id: reply.generationId, user_stopped: !leavingTale }, { keepalive: leavingTale })
        .catch(() => reply.controller.abort());
    }
    if (!reply.accepted || leavingTale) reply.controller.abort();
    if (leavingTale && activeReply === reply) activeReply = undefined;
    refreshComposer();
  }

  function updateReplyTurn(reply: Reply) {
    const assistant = reply.assistant;
    const world = currentWorld();
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

    updateReplyTime(reply);
  }

  function updateReplyTime(reply: Reply) {
    const article = document.querySelector(`#messages [data-message="${reply.assistant.id}"]`);
    const time = article?.querySelector(".reply-time");
    if (time) time.textContent = formatDuration(reply.assistant.elapsed_ms ?? performance.now() - reply.startedAtMs);
  }

  function renderReply(reply: Reply) {
    if (reply.renderFrame !== undefined || currentTale() !== reply.tale || activeReply !== reply) return;
    reply.renderFrame = requestAnimationFrame(() => {
      reply.renderFrame = undefined;
      if (currentTale() === reply.tale && activeReply === reply) keepReadingPosition(() => updateReplyTurn(reply));
    });
  }

  function applyGenerationEvent(reply: Reply, event: GenerationEvent, followLatest: boolean) {
    const { tale } = reply;
    switch (event.type) {
      case "accepted":
        Object.assign(tale, event.tale, { draft: false });
        reply.accepted = true;
        reply.assistant = tale.messages.find(message => message.id === event.assistant.id)!;
        storeTale(event.tale);
        if (currentTale() === tale && activeReply === reply) keepReadingPosition(renderMessages, followLatest);
        if (reply.stopping && !reply.controller.signal.aborted) stopReply(reply);
        break;
      case "saved":
        reply.accepted = true;
        Object.assign(tale, event.tale, { draft: false });
        storeTale(event.tale);
        break;
      case "done":
        Object.assign(reply.assistant, event.message);
        if (event.error && currentTale() === tale) showToast(event.error);
        if (event.prompt_counts) {
          tale.prompt_counts = event.prompt_counts;
          if (currentTale() === tale) refreshPromptCounts(tale.prompt_counts);
        }
        break;
      case "retry":
        reply.assistant.content = "";
        reply.assistant.thinking = "";
        reply.assistant.thinking_ms = null;
        break;
      case "thinking":
        reply.assistant.thinking += event.text;
        reply.assistant.thinking_ms = event.thinking_ms;
        break;
      case "reply":
        reply.assistant.content += event.text;
        break;
    }
    renderReply(reply);
  }

  async function sendOrStop(rewrite?: ReplyTarget) {
    const tale = currentTale();
    const world = currentWorld();
    if (!tale || !world || isTurnBusy()) return;
    if (activeReply) {
      if (!rewrite) stopReply(activeReply);
      return;
    }

    const input = element<HTMLTextAreaElement>("message-input");
    const text = input.value.trim();
    const settings = currentChatSettings();
    if ((!text && !rewrite) || !settings || element<HTMLButtonElement>("send-message").disabled) return;
    const missingKeys = warnMissingKeys(world, settings);
    if (rewrite && missingKeys) return;
    const replacedMessage = rewrite?.mode === "answer" ? undefined : rewrite?.message;
    const followLatest = !rewrite;
    const originalDraft = input.value;
    const previousMessages = tale.messages;
    const selectedOpening = tale.draft ? tale.messages.find(message => message.opening)?.swipe : undefined;
    const playerPersona = currentPersona();
    const pendingSwipe: Swipe = { content: "", thinking: "", model: settings.model, status: "generating",
      elapsed_ms: null, thinking_ms: null, error: null, has_signature: false };
    const assistant: Message = {
      ...replacedMessage, ...pendingSwipe, id: replacedMessage?.id ?? PENDING_ASSISTANT_MESSAGE_ID, role: "assistant",
    };
    const reply: Reply = {
      tale, generationId: newId(), controller: new AbortController(), assistant, accepted: false,
      stopping: false, startedAtMs: performance.now(),
    };
    activeReply = reply;
    if (rewrite?.mode === "swipe") {
      const swipes = rewrite.message.swipes ?? [rewrite.message];
      assistant.swipe = swipes.length;
      assistant.swipes = [...swipes, pendingSwipe];
    }
    if (rewrite) {
      const retainedMessages = replacedMessage ? previousMessages.slice(0, -1) : previousMessages;
      tale.messages = [...retainedMessages, assistant];
    } else {
      input.value = "";
      clearDraft(tale.id);
      const pendingUserMessage: Message = {
        id: PENDING_USER_MESSAGE_ID, role: "user", content: text, thinking: "", model: null,
        status: "complete", elapsed_ms: null, thinking_ms: null,
        player_name: playerPersona?.name, player_artwork: playerPersona?.artwork,
      };
      tale.messages = [...previousMessages, pendingUserMessage];
      if (!missingKeys) tale.messages.push(assistant);
    }
    keepReadingPosition(renderMessages, followLatest);
    reply.clockTimer = window.setInterval(() => {
      if (activeReply === reply) updateReplyTime(reply);
    }, REPLY_CLOCK_INTERVAL_MS);

    try {
      const turn = rewrite
        ? { message_id: rewrite.message.id, swipe: rewrite.message.swipe ?? 0, mode: rewrite.mode }
        : { content: text, opening: selectedOpening ?? (tale.draft ? 0 : undefined), persona_id: tale.persona_id };
      const request = { generation_id: reply.generationId, title: tale.title, settings, ...turn };
      const response = await post(`${taleRoute(tale)}/generate`, request, { signal: reply.controller.signal });
      if (!response.ok) throw await apiError(response);

      let receivedFinalEvent = false;
      await readGenerationEvents(response, event => {
        applyGenerationEvent(reply, event, followLatest);
        if (event.type === "saved" || event.type === "done") receivedFinalEvent = true;
      });
      if (!receivedFinalEvent) throw new Error("The connection closed before the reply finished.");
    } catch (error) {
      if (!reply.stopping && !reply.controller.signal.aborted && currentTale() === tale) showToast(error);
      if (!reply.accepted) {
        tale.messages = previousMessages;
        if (!rewrite) {
          restoreDraft(tale.id, originalDraft);
          if (currentTale() === tale && !input.value) input.value = originalDraft;
        }
      }
    } finally {
      window.clearInterval(reply.clockTimer);
      if (reply.assistant.status === "generating") reply.assistant.status = reply.stopping ? "stopped" : "error";
      if (reply.renderFrame !== undefined) cancelAnimationFrame(reply.renderFrame);
      if (activeReply === reply) {
        activeReply = undefined;
        if (currentTale() === tale) keepReadingPosition(renderMessages, followLatest);
      }
      if (reply.accepted || reply.controller.signal.aborted) {
        void loadTales().then(onTalesChanged, error => showToast(error));
      }
    }
  }

  function leave() {
    if (activeReply) stopReply(activeReply, "leave");
  }

  return { get active(): Readonly<Reply> | undefined { return activeReply; }, sendOrStop, leave };
}

async function readGenerationEvents(response: Response, consume: (event: GenerationEvent) => void) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let pendingLine = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      pendingLine += value;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop()!;
      for (const line of lines) if (line) consume(JSON.parse(line) as GenerationEvent);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
