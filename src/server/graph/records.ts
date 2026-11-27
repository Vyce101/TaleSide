import type { Endpoint } from "../../shared/extraction.js";
export * from "../../shared/extraction.js";

export function normalizedName(name: string) {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toUpperCase();
}

export function entityIdentity(entity: Endpoint) {
  return JSON.stringify([normalizedName(entity.name), entity.type]);
}

export function graphRecordTitle(name: string, type: string | null) {
  return type ? `${name} (${type})` : name;
}
