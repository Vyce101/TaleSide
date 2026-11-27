import type { DatabaseSync } from "node:sqlite";
import type { InspectorMap, InspectorRecord, InspectorRecordDetail, InspectorRecordPage } from "../../shared/inspectors.js";
import { normalizedName } from "../graph/records.js";
import { GraphResolution, rawGraphNotes } from "../graph/resolution.js";
import { get } from "../sqlite.js";
import { RequestError } from "../validation.js";
import type { WorldRow } from "./storage.js";

const PAGE_SIZE = 60;

type GraphCounts = { entities: number; relationships: number };
type GraphSnapshot = { counts: GraphCounts; revision: string } & (
  { mode: "ready" | "resolving"; generation: number } |
  { mode: "extracted"; graph: GraphResolution } |
  { mode: "empty" }
);
type RecordListFilters = {
  kind: "all" | "entities" | "relationships";
  search: string;
  ascending: boolean;
  offset: number;
  entityType: string;
};
type ResolvedRecord = {
  id: string; name: string; type: string | null; source: string | null; target: string | null;
  raw: string; summary: string | null; embedded: number; fingerprint: string;
};

function countGraphRecords(records: Iterable<InspectorRecord>) {
  const distribution: Record<string, number> = {};
  let entities = 0;
  let relationships = 0;
  for (const record of records) {
    if (record.type === null) relationships++;
    else {
      distribution[record.type] = (distribution[record.type] ?? 0) + 1;
      entities++;
    }
  }
  return { entities, relationships, distribution };
}

function countRecordRelationships(records: InspectorRecordDetail[]) {
  const degrees = new Map<string, number>();
  for (const { source, target } of records) {
    if (source) degrees.set(source, (degrees.get(source) ?? 0) + 1);
    if (target && target !== source) degrees.set(target, (degrees.get(target) ?? 0) + 1);
  }
  for (const record of records) record.relationships = degrees.get(record.id) ?? 0;
}

export class WorldInspectorGraph {
  private provisional?: { key: string; cursor: number; graph: GraphResolution };

  constructor(private db: DatabaseSync) {}

  summary(world: WorldRow) {
    const { counts, revision } = this.selectGraph(world);
    return { ...counts, revision };
  }

  map(world: WorldRow, publishedOnly: boolean, revision: string | null): InspectorMap | { revision: string } {
    const graph = this.selectGraph(world, publishedOnly);
    if (revision === graph.revision) return { revision };
    const nodes: InspectorMap["nodes"] = [];
    const edges: InspectorMap["edges"] = [];
    if ("generation" in graph) {
      const rows = this.db.prepare(`
        SELECT r.identity AS id, r.name, r.type, s.identity AS source, t.identity AS target,
          r.input AS raw, r.fingerprint || ':' || (r.description IS NOT NULL) || ':' || (r.vector IS NOT NULL) AS version
        FROM graph_records r LEFT JOIN graph_records s ON r.source = s.id LEFT JOIN graph_records t ON r.target = t.id
        WHERE r.generation = ? ORDER BY r.id
      `).iterate(graph.generation) as Iterable<InspectorRecord & { raw: string }>;
      for (const { id, name, type, version, source, target, raw } of rows) {
        const record = { id, name, type, version, source_notes: raw.match(/^B[0-9]+:C[0-9]+: /gm)?.length ?? 0 };
        if (source && target) edges.push({ ...record, source, target });
        else if (type) nodes.push(record);
      }
    } else if (graph.mode === "extracted") {
      for (const item of graph.graph.records()) {
        const { id, name, type } = item;
        const record = { id, name, type, version: String(item.notes.length), source_notes: rawGraphNotes(item.notes).length };
        if ("source" in item) edges.push({ ...record, source: item.source, target: item.target });
        else nodes.push(record);
      }
    }
    return { mode: graph.mode, revision: graph.revision, nodes, edges };
  }

  list(world: WorldRow, publishedOnly: boolean,
    { kind, search, ascending, offset, entityType }: RecordListFilters): InspectorRecordPage {
    const graph = this.selectGraph(world, publishedOnly);
    const records = [...this.records(graph)];
    countRecordRelationships(records);
    const query = normalizedName(search);
    const matchingRecords = records.filter(record => {
      const relationship = record.type === null;
      if (kind === "entities" && relationship) return false;
      if (kind === "relationships" && !relationship) return false;
      if (kind !== "relationships" && entityType && record.type !== entityType) return false;
      return normalizedName(`${record.name} ${record.type ?? "relationship"}`).includes(query);
    });
    matchingRecords.sort((a, b) => (ascending ? a.chunks - b.chunks : b.chunks - a.chunks) || a.name.localeCompare(b.name));
    const items = matchingRecords.slice(offset, offset + PAGE_SIZE).map(({ raw: _raw, summary: _summary, ...item }) => item);
    return { ...countGraphRecords(records), items, more: matchingRecords.length > offset + PAGE_SIZE };
  }

  record(world: WorldRow, recordId: string, publishedOnly: boolean): InspectorRecordDetail {
    const graph = this.selectGraph(world, publishedOnly);
    const record = this.records(graph, recordId).next().value;
    if (!record) throw new RequestError("The graph record is no longer available.", 404);
    if (record.type !== null) {
      if ("generation" in graph) {
        record.relationships = get<{ count: number }>(this.db, `
          SELECT count(*) AS count FROM graph_records r
          WHERE r.generation = ? AND (
            r.source = (SELECT id FROM graph_records WHERE generation = ? AND identity = ?)
            OR r.target = (SELECT id FROM graph_records WHERE generation = ? AND identity = ?)
          )
        `, graph.generation, graph.generation, recordId, graph.generation, recordId)!.count;
      } else if (graph.mode === "extracted") {
        for (const item of graph.graph.records()) {
          if ("source" in item && (item.source === record.id || item.target === record.id)) record.relationships++;
        }
      }
    }
    return record;
  }

  private selectGraph(world: WorldRow, publishedOnly = false): GraphSnapshot {
    const generation = publishedOnly || world.status === "ready" ? world.graph_published : world.graph_building;
    if (generation !== null) {
      const counts = get<GraphCounts & { summarized: number; embedded: number }>(this.db, `
        SELECT count(*) FILTER (WHERE type IS NOT NULL) AS entities,
          count(*) FILTER (WHERE type IS NULL) AS relationships,
          count(description) AS summarized, count(vector) AS embedded
        FROM graph_records WHERE generation = ?
      `, generation)!;
      return { counts, generation, mode: generation === world.graph_published ? "ready" : "resolving",
        revision: `${world.book_revision}:${generation}:${counts.summarized}:${counts.embedded}:${world.graph_published}` };
    }
    if (publishedOnly || !world.graph_settings) return {
      mode: "empty", revision: `empty:${world.book_revision}`, counts: { entities: 0, relationships: 0 },
    };
    // Reuse completed extraction passes until the selected World or its index changes.
    const key = `${world.id}:${world.book_revision}:${world.index_number}`;
    if (this.provisional?.key !== key) this.provisional = { key, cursor: 0, graph: new GraphResolution() };
    const cachedGraph = this.provisional;
    const passes = this.db.prepare(`
      SELECT p.rowid AS sequence, b.number AS book, p.chunk_number AS chunk, p.records
      FROM graph_passes p JOIN books b ON b.id = p.book_id
      WHERE b.world_id = ? AND p.index_number = ? AND p.rowid > ? ORDER BY p.rowid
    `).iterate(world.id, world.index_number, cachedGraph.cursor) as Iterable<{
      sequence: number; book: number; chunk: number; records: string;
    }>;
    for (const pass of passes) {
      cachedGraph.graph.add(pass);
      cachedGraph.cursor = pass.sequence;
    }
    return { graph: cachedGraph.graph, mode: "extracted", revision: `${key}:${cachedGraph.cursor}`, counts: cachedGraph.graph.counts };
  }

  private *records(graph: GraphSnapshot, onlyRecordId?: string): IterableIterator<InspectorRecordDetail> {
    if ("generation" in graph) {
      const rows = this.db.prepare(`
        SELECT r.identity AS id, r.name, r.type, s.identity AS source, t.identity AS target,
          r.input AS raw, r.description AS summary, r.vector IS NOT NULL AS embedded, r.fingerprint
        FROM graph_records r LEFT JOIN graph_records s ON r.source = s.id LEFT JOIN graph_records t ON r.target = t.id
        WHERE r.generation = ? AND (? IS NULL OR r.identity = ?) ORDER BY r.id
      `).iterate(graph.generation, onlyRecordId ?? null, onlyRecordId ?? null) as Iterable<ResolvedRecord>;
      for (const row of rows) {
        const { id, name, type, raw, summary, source, target, fingerprint } = row;
        yield { id, name, type, source: source ?? undefined, target: target ?? undefined, raw: onlyRecordId ? raw : "",
          summary: onlyRecordId ? summary : null, resolved: true, summarized: summary !== null, embedded: Boolean(row.embedded),
          chunks: new Set(raw.match(/^B[0-9]+:C[0-9]+(?=:)/gm)).size, relationships: 0,
          version: `${fingerprint}:${Number(summary !== null)}:${row.embedded}` };
      }
      return;
    }
    if (graph.mode !== "extracted") return;
    for (const record of graph.graph.records()) {
      if (onlyRecordId && onlyRecordId !== record.id) continue;
      const endpoints = "source" in record ? { source: record.source, target: record.target } : {};
      yield { ...endpoints, id: record.id, name: record.name, type: record.type,
        version: String(record.notes.length), raw: onlyRecordId ? rawGraphNotes(record.notes).join("\n\n") : "", summary: null,
        chunks: new Set(record.notes.map(note => `${note.book}:${note.chunk}`)).size,
        relationships: 0, resolved: false, summarized: false, embedded: false };
    }
  }
}
