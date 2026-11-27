export type PassageTrace = {
  book: number; chunk: number; name: string; similarity: number; text: string; preceding?: string;
  included: boolean;
};

export type GraphTrace = {
  id: number; name: string; type: string | null; description: string;
  source?: number; target?: number; reason: string; excluded_reason?: string; included: boolean; hop: number;
};

export type GraphEndpoint = { id: number; name: string; type: string | null };

export type HistoryTrace = {
  turn: number; role: "user" | "assistant"; name: string; model: string | null;
  text: string; thinking: string; has_thinking: boolean; has_signature: boolean; signature_sent: boolean;
};

export type PromptTrace = {
  id: string; name: string; kind: string; characters: number; text?: string;
};

export type RequestCaptureTrace = {
  sections: PromptTrace[];
  history: HistoryTrace[];
  chunks: PassageTrace[];
  graph: GraphTrace[];
  endpoints: GraphEndpoint[];
  sources: Record<string, string>;
  retrieved_parts: string[];
  graph_characters: number;
  chunk_characters: number;
  minimum_similarity: number;
  below_minimum: number;
  other_skipped_chunks: number;
  other_skipped_graph: number;
};

export type MessageContext = {
  model: string; input_tokens: number | null; characters: number; raw: string;
  trace: Omit<RequestCaptureTrace, "retrieved_parts"> & {
    graph_preview?: { message_id: number; graph: GraphTrace[]; endpoints: GraphEndpoint[]; sources: Record<string, string> };
  };
};
