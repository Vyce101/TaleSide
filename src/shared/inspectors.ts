export type GraphTrace = {
  id: number; name: string; type: string | null; description: string;
  source?: number; target?: number; reason: string; excluded_reason?: string; included: boolean; hop: number;
};

export type GraphEndpoint = { id: number; name: string; type: string | null };

