import type { ChatSettings, GenerationEvent, Message, Persona, Swipe, World } from "../../shared/types.js";
import { apiError, loadTales, newId, post, storeTale, taleRoute, type OpenTale } from "../data.js";
import { element } from "../dom.js";
import { refreshPromptCounts } from "../prompts.js";
import { showToast } from "../toasts.js";
import { fillMessageText, formatDuration, messageTurn } from "../view.js";
import { keepReadingPosition } from "./reading-position.js";

type Reply = { tale: OpenTale; id: string; controller: AbortController; assistant: Message; accepted: boolean; stopping: boolean; started: number; timer?: number; frame?: number };

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

  function stopReply(reply: Reply, leaving = false) {
    reply.stopping = true;
    if (leaving) window.clearInterval(reply.timer);
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
    if (time) time.textContent = formatDuration(reply.assistant.elapsed_ms ?? performance.now() - reply.started);
  }

  function renderReply(reply: Reply) {
    if (reply.frame !== undefined || currentTale() !== reply.tale || activeReply !== reply) return;
    reply.frame = requestAnimationFrame(() => {
      reply.frame = undefined;
      if (currentTale() === reply.tale && activeReply === reply) keepReadingPosition(() => updateReplyTurn(reply));
    });
  }

  async function sendOrStop(rewrite?: { message: Message; mode: "regenerate" | "swipe" | "answer" }) {
    const tale = currentTale();
    const world = currentWorld();
    if (!tale || !world || isTurnBusy()) return;
    if (activeReply) { if (!rewrite) stopReply(activeReply); return; }
    const input = element<HTMLTextAreaElement>("message-input");
    const text = input.value.trim();
    const settings = currentChatSettings();
    if ((!text && !rewrite) || !settings || element<HTMLButtonElement>("send-message").disabled) return;
    const missingKeys = warnMissingKeys(world, settings);
    if (rewrite && missingKeys) return;
    const replacesReply = rewrite && rewrite.mode !== "answer";
    const originalDraft = input.value;
    const previousMessages = tale.messages;
    const opening = tale.draft ? tale.messages.find(message => message.opening)?.swipe : undefined;
    const draftPlayer = currentPersona();
    const preview: Swipe = { content: "", thinking: "", model: settings.model, status: "generating",
      elapsed_ms: null, thinking_ms: null, error: null, has_signature: false };
    const assistant: Message = { ...(replacesReply ? rewrite.message : {}), ...preview,
      id: replacesReply ? rewrite.message.id : -2, role: "assistant" };
    const reply: Reply = { tale, id: newId(), controller: new AbortController(), assistant, accepted: false,
      stopping: false, started: performance.now() };
    activeReply = reply;
    if (rewrite?.mode === "swipe") {
      const swipes = rewrite.message.swipes ?? [rewrite.message];
      assistant.swipe = swipes.length;
      assistant.swipes = [...swipes, preview];
    }
    if (replacesReply) {
      tale.messages = [...previousMessages.slice(0, -1), assistant];
    } else if (rewrite) {
      tale.messages = [...previousMessages, assistant];
    } else {
      input.value = "";
      clearDraft(tale.id);
      tale.messages = [...previousMessages, { id: -1, role: "user", content: text, thinking: "", model: null,
        status: "complete", elapsed_ms: null, thinking_ms: null, player_name: draftPlayer?.name,
        player_artwork: draftPlayer?.artwork }, ...(missingKeys ? [] : [assistant])];
    }
    keepReadingPosition(renderMessages, !rewrite);
    reply.timer = window.setInterval(() => { if (activeReply === reply) updateReplyTime(reply); }, 250);
    try {
      const response = await post(`${taleRoute(tale)}/generate`,
        { generation_id: reply.id, title: tale.title, settings, ...(rewrite
          ? { message_id: rewrite.message.id, swipe: rewrite.message.swipe ?? 0, mode: rewrite.mode }
          : { content: text, opening: opening ?? (tale.draft ? 0 : undefined), persona_id: tale.persona_id }) },
        { signal: reply.controller.signal });
      if (!response.ok) throw await apiError(response);
      let finished = false;
      await readReply(response, event => {
        if (event.type === "accepted") {
          Object.assign(tale, event.tale, { draft: false });
          reply.accepted = true;
          reply.assistant = tale.messages.find(message => message.id === event.assistant.id)!;
          storeTale(event.tale);
          if (currentTale() === tale && activeReply === reply) keepReadingPosition(renderMessages, !rewrite);
          if (reply.stopping && !reply.controller.signal.aborted) stopReply(reply);
        } else if (event.type === "saved") {
          finished = true;
          reply.accepted = true;
          Object.assign(tale, event.tale, { draft: false });
          storeTale(event.tale);
        } else if (event.type === "done") {
          finished = true;
          Object.assign(reply.assistant, event.message);
          if (event.error && currentTale() === tale) showToast(event.error);
          if (event.prompt_counts) {
            tale.prompt_counts = event.prompt_counts;
            if (currentTale() === tale) refreshPromptCounts(tale.prompt_counts);
          }
        } else if (event.type === "retry") {
          reply.assistant.content = "";
          reply.assistant.thinking = "";
          reply.assistant.thinking_ms = null;
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
      if (!reply.stopping && !reply.controller.signal.aborted && currentTale() === tale) showToast(error);
      if (!reply.accepted) {
        tale.messages = previousMessages;
        if (!rewrite) {
          restoreDraft(tale.id, originalDraft);
          if (currentTale() === tale && !input.value) input.value = originalDraft;
        }
      }
    } finally {
      window.clearInterval(reply.timer);
      if (reply.assistant.status === "generating") reply.assistant.status = reply.stopping ? "stopped" : "error";
      if (reply.frame !== undefined) cancelAnimationFrame(reply.frame);
      if (activeReply === reply) {
        activeReply = undefined;
        if (currentTale() === tale) keepReadingPosition(renderMessages, !rewrite);
      }
      if (reply.accepted || reply.controller.signal.aborted) {
        void loadTales().then(onTalesChanged, error => showToast(error));
      }
    }
  }

  function leave() {
    if (activeReply) stopReply(activeReply, true);
  }

  return { get active(): Readonly<Reply> | undefined { return activeReply; }, sendOrStop, leave };
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
