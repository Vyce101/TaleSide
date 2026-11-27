export const ENTITY_TYPES = ["CHARACTER", "LOCATION", "FACTION/GROUP", "SYSTEM_OR_WORLD_RULE", "ITEM", "EVENT"] as const;
export type EntityType = typeof ENTITY_TYPES[number];
export type Endpoint = { name: string; type: EntityType };
export type EntityRecord = Endpoint & { kind: "entity"; description: string };
export type EdgeRecord = { kind: "relationship"; source: Endpoint; target: Endpoint; description: string; strength: number };
export type Extraction = EntityRecord | EdgeRecord;
