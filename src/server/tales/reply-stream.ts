import { GEMMA } from "../../shared/models.js";
import type { ChatSettings, GenerationEvent, Message } from "../../shared/types.js";
import type { GeminiClient, Part } from "../gemini.js";
import type { ProviderKeys } from "../keys.js";

export function createReplyStream(keys: ProviderKeys, provider: GeminiClient, settings: ChatSettings,
  signal: AbortSignal, emit: (event: GenerationEvent) => void) {
  const signedParts: Part[] = [];
  return {
    async send(payload: object, assistant: Message, started: number,
      onAttempt: () => void, onPromptTokens: (tokens: number) => void) {
      const resetReply = () => {
        assistant.content = "";
        assistant.thinking = "";
        assistant.thinking_ms = null;
        signedParts.length = 0;
        emit({ type: "retry" });
      };
      for await (const part of chatWithRetry(keys, provider, settings, payload, signal, resetReply, onAttempt, onPromptTokens)) {
        signal.throwIfAborted();
        if (typeof part.text === "string" && part.text) {
          if (part.thought) {
            assistant.thinking_ms = Math.round(performance.now() - started);
            assistant.thinking += part.text;
            emit({ type: "thinking", text: part.text, thinking_ms: assistant.thinking_ms });
          } else {
            assistant.content += part.text;
            emit({ type: "reply", text: part.text });
          }
        }
        if (!part.thought && settings.model !== GEMMA && settings.thought_signatures && typeof part.text === "string") {
          if (typeof part.thoughtSignature === "string" && part.thoughtSignature) {
            signedParts.push({ text: part.text, thoughtSignature: part.thoughtSignature });
          } else if (part.text) {
            const prior = signedParts.at(-1);
            if (prior && !prior.thoughtSignature) prior.text += part.text;
            else signedParts.push({ text: part.text });
          }
        }
      }
      signal.throwIfAborted();
    },
    signedParts() {
      return signedParts.some(part => part.thoughtSignature) ? JSON.stringify(signedParts) : null;
    },
  };
}

async function* chatWithRetry(keys: ProviderKeys, provider: GeminiClient, settings: ChatSettings, payload: object, signal: AbortSignal, resetReply: () => void,
  onAttempt: () => void, onPromptTokens: (tokens: number) => void) {
  let streamed = false;
  for (const { readKey, last } of keys.attempts("chat", settings.chat_key_ids, signal)) {
    let started = false;
    const pending: Part[] = [];
    try {
      const key = readKey();
      signal.throwIfAborted();
      onAttempt();
      for await (const part of provider.chat(settings.model, key, payload, signal, { onPromptTokens })) {
        signal.throwIfAborted();
        if (!started && !part.text) { pending.push(part); continue; }
        if (!started) {
          started = true;
          if (streamed) resetReply();
          streamed = true;
          yield* pending;
        }
        yield part;
      }
      signal.throwIfAborted();
      if (!started) throw new Error("Gemini returned no reply.");
      return;
    } catch (error) {
      if (last || signal.aborted) throw error;
    }
  }
}
