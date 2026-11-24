export const ENTITY_TYPES = ["CHARACTER", "LOCATION", "FACTION/GROUP", "SYSTEM_OR_WORLD_RULE", "ITEM", "EVENT"] as const;
export type EntityType = typeof ENTITY_TYPES[number];
export type Endpoint = { name: string; type: EntityType };
export type EntityRecord = Endpoint & { kind: "entity"; description: string };
export type EdgeRecord = { kind: "relationship"; source: Endpoint; target: Endpoint; description: string; strength: number };
export type Extraction = EntityRecord | EdgeRecord;

export function normalizedName(name: string) {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toUpperCase();
}

export function entityIdentity(entity: Endpoint) {
  return JSON.stringify([normalizedName(entity.name), entity.type]);
}

export function graphRecordTitle(name: string, type: string | null) {
  return type ? `${name} (${type})` : name;
}
