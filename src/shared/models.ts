import type { ChatModel } from "./types.js";

export const HYDROGEN = "gemini-4-hydrogen";
export const FLASH_LITE = "gemini-3.5-flash-lite";
export const GEMMA = "gemma-4-31b-it";

export const CHAT_MODELS: ChatModel[] = [
  { id: HYDROGEN, label: "Gemini 4 Hydrogen", context_limit: 1048576, max_output: 65536,
    thinking_levels: ["LOW", "MEDIUM", "HIGH", "XHIGH"], default_thinking: "HIGH", replay_thinking: true },
  { id: FLASH_LITE, label: "Gemini 3.5 Flash-Lite", context_limit: 1048576, max_output: 65536,
    thinking_levels: ["MINIMAL", "LOW", "MEDIUM", "HIGH"], default_thinking: "MINIMAL", replay_thinking: true },
  { id: GEMMA, label: "Gemma 4 31B IT", context_limit: 262144, max_output: 32768,
    thinking_levels: ["MINIMAL", "HIGH"], default_thinking: "HIGH", replay_thinking: false },
];

export const GEMMA_SAMPLING = { temperature: 1.0, topP: 0.95, topK: 64 };
