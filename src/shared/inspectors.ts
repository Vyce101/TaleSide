import type { World } from "./types.js";
import type { Extraction } from "./extraction.js";

export type ActivityKind = "extraction" | "embedding" | "graph";
export type ActivityStatus = "running" | "complete" | "error" | "stopped";
export type ActivityStep = { label: string; at: number; severity?: "warning" | "error"; error?: string; key_name?: string };
export type ActivityLocation = { book?: number; chunk?: number; pass?: number; record?: string };

export type ActivityEvent = {
  id: number; operation: number; kind: ActivityKind; status: ActivityStatus;
  name: string; location: ActivityLocation; at: number; elapsed: number | null; revision: number;
  operation_name: string; severity?: "warning" | "error"; keys?: { count: number; name?: string };
};

export type ActivityDetail = {
  id: number; kind: ActivityKind; name: string; started: number; ended: number | null; status: ActivityStatus;
  location: ActivityLocation; steps: ActivityStep[]; input: string; output: string; thinking: string;
  clipped: boolean; steps_clipped: boolean; expired: boolean; error: string | null; revision: number;
};

export type ActiveOperation = Pick<ActivityDetail, "id" | "kind" | "name" | "location" | "started">;
export type InspectorNode = { id: string; name: string; type: string | null; version: string; };
export type InspectorEdge = InspectorNode & { source: string; target: string };
export type InspectorMap = {
  revision: string; mode: "extracted" | "resolving" | "ready" | "empty";
  nodes: (InspectorNode & { source_notes: number })[];
  edges: (InspectorEdge & { source_notes: number })[];
};
export type InspectorRecord = InspectorNode & {
  source?: string; target?: string; chunks: number; relationships: number;
  resolved: boolean; summarized: boolean; embedded: boolean;
};
export type InspectorRecordDetail = InspectorRecord & { raw: string; summary: string | null };
export type InspectorRecordPage = {
  entities: number; relationships: number; distribution: Record<string, number>;
  items: InspectorRecord[]; more: boolean;
};

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
