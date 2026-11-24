import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import type { ChatSettings } from "../../shared/types.js";
import { normalizedName } from "./extraction.js";
import { graphRecordTitle } from "./jobs.js";
import { graphPaths } from "./indexes.js";
import { VectorIndex } from "./vector-index.js";

const HUB_EDGES = 150;
const HOP_WIDTH = 20;
const SEED_CANDIDATES_PER_MATCH = 10;
const EDGE_SIMILARITY_WEIGHT = 0.8;
const EDGE_STRENGTH_WEIGHT = 0.2;
const WORD = /[\p{L}\p{M}\p{N}_]/u;
const TOKEN = /[\p{L}\p{M}\p{N}_]+|[^\p{L}\p{M}\p{N}_\s]/gu;
type Row = { id: number; name: string; type: string | null; source: number | null; target: number | null;
  strength: number | null; characters: number };
type Neighbor = { id: number; edge: number; strength: number };
type Name = { name: string; id: number };
export type GraphContext = { entities: number; relationships: number; notes: string[] };
export type GraphQuery = Pick<ChatSettings, "graph_budget" | "graph_matches" | "graph_hops" | "graph_edges">
  & { vector: number[]; text: string };

const { database, directory, generation } = workerData as { database: string; directory: string; generation: number };
const db = new DatabaseSync(database, { readOnly: true, timeout: 5000 });
const paths = graphPaths(directory, generation);
const { dimensions } = db.prepare("SELECT dimensions FROM graph_generations WHERE id = ?")
  .get(generation) as { dimensions: number };

function build() {
  mkdirSync(directory, { recursive: true });
  const index = new VectorIndex(dimensions);
  const unfinished = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, path + ".tmp"])) as typeof paths;
  const fd = openSync(unfinished.vectors, "w");
  try {
    const rows = db.prepare("SELECT id, type, vector FROM graph_records WHERE generation = ? ORDER BY id")
      .iterate(generation) as Iterable<{ id: number; type: string | null; vector: Uint8Array }>;
    for (const row of rows) {
      const vector = new Float32Array(Uint8Array.from(row.vector).buffer);
      index.add(row.id, row.type !== null, vector);
      if (row.type === null) {
        const buffer = new Uint8Array(Float16Array.from(vector).buffer);
        let written = 0;
        while (written < buffer.length) written += writeSync(fd, buffer, written, buffer.length - written);
      }
    }
    fsyncSync(fd);
    closeSync(fd);
    index.save(unfinished);
    for (const path of [unfinished.entities, unfinished.edges]) {
      const saved = openSync(path, "r+");
      try { fsyncSync(saved); } finally { closeSync(saved); }
    }
    for (const key of ["entities", "edges", "vectors"] as const) renameSync(unfinished[key], paths[key]);
  } catch (error) {
    try { closeSync(fd); } catch { /* Already closed. */ }
    for (const path of Object.values(unfinished)) {
      try { unlinkSync(path); } catch { /* The file might not have been created. */ }
    }
    throw error;
  }
}

function attach(records: Map<number, { length: number; endpoints?: [number, number]; offset?: number }>,
  names: Map<string, Name[]>, adjacency: Map<number, Neighbor[]>, row: Row, offset: number) {
  if (row.type !== null) {
    const name = normalizedName(row.name);
    const first = name.match(TOKEN)?.[0];
    if (first) {
      const candidates = names.get(first) ?? [];
      candidates.push({ name, id: row.id });
      names.set(first, candidates);
    }
    records.set(row.id, { length: row.characters });
    return;
  }
  const source = row.source!;
  const target = row.target!;
  const strength = row.strength!;
  records.set(row.id, { length: row.characters, endpoints: [source, target], offset });
  for (const [from, to] of [[source, target], [target, source]]) {
    const neighbors = adjacency.get(from) ?? [];
    neighbors.push({ id: to, edge: row.id, strength });
    adjacency.set(from, neighbors);
  }
}

function createSearch() {
  const index = new VectorIndex(dimensions);
  const records = new Map<number, { length: number; endpoints?: [number, number]; offset?: number }>();
  const names = new Map<string, Name[]>();
  const adjacency = new Map<number, Neighbor[]>();
  let entities = 0;
  let relationships = 0;
  const rows = db.prepare("SELECT id, name, type, source, target, strength, characters FROM graph_records WHERE generation = ? ORDER BY id")
    .iterate(generation) as Iterable<Row>;
  for (const row of rows) {
    attach(records, names, adjacency, row, relationships);
    if (row.type === null) relationships++;
    else entities++;
  }
  for (const [id, neighbors] of adjacency) {
    neighbors.sort((a, b) => b.strength - a.strength || a.edge - b.edge);
    if (neighbors.length > HUB_EDGES) adjacency.set(id, neighbors.slice(0, HUB_EDGES));
  }
  index.view(paths, entities, relationships);

  return (query: GraphQuery): GraphContext => {
    const selected = new Set<number>();
    const visited = new Set<number>();
    const scoredEdges = new Map<number, number>();
    const vector = Float32Array.from(query.vector);
    const queryLength = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    let remaining = query.graph_budget;

    function include(id: number) {
      if (selected.has(id)) return false;
      const entry = records.get(id);
      if (!entry) return false;
      const cost = entry.length + (selected.size ? 2 : 0);
      if (cost > remaining) return false;
      selected.add(id);
      remaining -= cost;
      return true;
    }

    function score(edge: Neighbor) {
      const cached = scoredEdges.get(edge.edge);
      if (cached !== undefined) return cached;
      const candidate = index.get_vector(records.get(edge.edge)!.offset!);
      let dot = 0;
      let squared = 0;
      for (let i = 0; i < vector.length; i++) {
        const value = candidate[i];
        dot += value * vector[i];
        squared += value * value;
      }
      const similarity = squared && queryLength ? dot / (Math.sqrt(squared) * queryLength) : 0;
      const result = EDGE_SIMILARITY_WEIGHT * similarity + EDGE_STRENGTH_WEIGHT * edge.strength / 10;
      scoredEdges.set(edge.edge, result);
      return result;
    }

    const exact = new Set<number>();
    const text = normalizedName(query.text);
    for (const token of text.matchAll(TOKEN)) {
      const previous = Array.from(text.slice(Math.max(0, token.index - 2), token.index)).at(-1);
      if (previous && WORD.test(previous)) continue;
      for (const candidate of names.get(token[0]) ?? []) {
        if (!text.startsWith(candidate.name, token.index)) continue;
        const next = text.codePointAt(token.index + candidate.name.length);
        if (next === undefined || !WORD.test(String.fromCodePoint(next))) exact.add(candidate.id);
      }
    }
    const semantic = index.search(vector, Math.min(records.size, query.graph_matches * SEED_CANDIDATES_PER_MATCH));
    const seeds: number[] = [];
    for (const id of [...exact, ...semantic.map(hit => hit.id)]) {
      if (seeds.length >= query.graph_matches) break;
      if (include(id)) seeds.push(id);
    }
    let frontier: number[] = [];
    let seedEdges: number[] = [];
    for (const seed of seeds) {
      if (records.get(seed)!.endpoints) seedEdges.push(seed);
      else {
        visited.add(seed);
        frontier.push(seed);
      }
    }
    for (let hop = 0; hop < query.graph_hops && (frontier.length || seedEdges.length) && remaining > 0; hop++) {
      const reached = new Map<number, number>();
      function visit(id: number, rank: number) {
        if (visited.has(id)) return;
        if (include(id) || selected.has(id)) reached.set(id, Math.max(rank, reached.get(id) ?? -Infinity));
      }
      for (const edge of seedEdges) for (const endpoint of records.get(edge)!.endpoints!) visit(endpoint, 1);
      seedEdges = [];
      for (const id of frontier) {
        const neighbors = (adjacency.get(id) ?? []).map(edge => ({ edge, rank: score(edge) }))
          .sort((a, b) => b.rank - a.rank || a.edge.edge - b.edge.edge);
        let accepted = 0;
        for (const { edge, rank } of neighbors) {
          if (accepted >= query.graph_edges) break;
          const newEdge = include(edge.edge);
          const canReach = !visited.has(edge.id) && !reached.has(edge.id);
          if (!newEdge && !(canReach && selected.has(edge.edge))) continue;
          accepted++;
          visit(edge.id, rank);
        }
      }
      for (const id of reached.keys()) visited.add(id);
      frontier = [...reached].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, HOP_WIDTH).map(([id]) => id);
    }
    const winners = db.prepare(`
      SELECT id, name, type, description FROM graph_records
      WHERE generation = ? AND id IN (SELECT value FROM json_each(?))
    `).all(generation, JSON.stringify([...selected])) as { id: number; name: string; type: string | null; description: string }[];
    const notes = new Map(winners.map(row => [row.id, graphRecordTitle(row.name, row.type) + "\n" + row.description]));
    return { entities, relationships, notes: [...selected].map(id => notes.get(id)!) };
  };
}

let search: ReturnType<typeof createSearch> | undefined;
parentPort!.on("message", ({ operation, query, port }: { operation: "build" | "search"; query: GraphQuery; port: MessagePort }) => {
  try {
    if (operation === "build") build();
    else search ??= createSearch();
    port.postMessage({ value: operation === "search" ? search!(query) : undefined });
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.message : "Could not read the World graph." });
  } finally { port.close(); }
});
