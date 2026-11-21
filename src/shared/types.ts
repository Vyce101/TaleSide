export type WorldStatus = "unindexed" | "creating" | "pausing" | "paused" | "failed" | "ready";
export type Book = { id: string; number: number; name: string; filename: string; total_chunks: number; embedded_chunks: number };
export type World = {
  id: string; name: string; status: WorldStatus; model: string; dimensions: number; max_token_limit: number;
  max_chunk_size: number; book_revision: number; artwork: string | null;
  progress: number; error: string | null; total_chunks: number; embedded_chunks: number; active_book: number | null; can_play: boolean;
  description: string; openings: string[];
  embedding_key_ids: string[]; retrieval_key_ids: string[]; books: Book[];
};
export type EmbeddingModel = { id: string; dimensions: number; max_token_limit: number };
export type KeySummary = { id: string; nickname: string; suffix: string | null; worlds: { id: string; name: string }[] };
export type KeyImpact = { worlds: KeySummary["worlds"]; busy: boolean };
export type KeySettings = { keys: KeySummary[]; models: EmbeddingModel[]; defaults: { model: string; key_ids: string[] } };
export type BuiltinPrompt = "world_description" | "world_info" | "persona" | "retrieved_passages" | "chat_history";
export type PromptRole = "system" | "user" | "model";
export type PromptBlock = { id: string; enabled: boolean } & (
  { kind: BuiltinPrompt; role?: PromptRole | "multi-role" } | { kind: "custom"; name: string; role: PromptRole; text: string }
);
export type Wrappers = Record<BuiltinPrompt, [string, string]>;
export type Persona = { id: string; name: string; nickname: string; description: string; artwork: string | null };
export type PersonasView = { personas: Persona[]; global: string | null; world: string | null };
export type ChatSettings = {
  model: string; chat_key_ids: string[]; thinking_level: string; thought_signatures: boolean;
  input_limit: number; output_limit: number; retrieved_chunks: number; minimum_similarity: number;
  chunk_overlap: number; messages_to_embed: number; wrappers: Wrappers; prompts: PromptBlock[];
};
export type Profile = { locked?: boolean; id: string; name: string; settings: ChatSettings };
export type ProfileSettings = { selected: string; profiles: Profile[]; models: ChatModel[]; defaults: ChatSettings };
export type ChatModel = { id: string; context_limit: number; max_output: number; thinking_levels: string[] };
export type TurnStatus = "complete" | "generating" | "stopped" | "error";
export type Swipe = {
  content: string; thinking: string; model: string | null; status: TurnStatus;
  elapsed_ms: number | null; thinking_ms: number | null; error?: string | null; has_signature?: boolean;
};
export type Message = Swipe & { id: number; role: "user" | "assistant";
  swipes?: Swipe[]; swipe?: number; opening?: boolean; player_name?: string | null; player_artwork?: string | null };
export type TaleSummary = { id: string; world_id: string; title: string; pinned: boolean; created_at: number;
  last_activity_at: number | null; message_count: number; content: string };
export type SearchSpan = { text: string; highlighted: boolean };
export type TaleSearchResult = TaleSummary & { match?: SearchSpan[] };
export type Tale = TaleSummary & { persona_id?: string | null; messages: Message[] };
export type GenerationEvent = { type: "accepted"; tale: Tale; user: Message; assistant: Message }
  | { type: "reply"; text: string }
  | { type: "thinking"; text: string; thinking_ms: number }
  | { type: "done"; message: Message; error?: string };
export type WorldSettings = { name: string; model: string; key_ids: string[];
  max_chunk_size: number };
