import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { graphPaths, type GraphContext, type GraphQuery } from "./index-protocol.js";
import { graphRecordTitle, normalizedName } from "./records.js";
import type { GraphEndpoint, GraphTrace } from "../../shared/inspectors.js";
import { VectorIndex } from "./vector-index.js";

const MAX_EDGES_PER_ENTITY = 150;
const MAX_ENTITIES_PER_HOP = 20;
const SEED_CANDIDATES_PER_MATCH = 10;
const EDGE_SIMILARITY_WEIGHT = 0.8;
const EDGE_STRENGTH_WEIGHT = 0.2;
const MAX_RELATIONSHIP_STRENGTH = 10;
const NOTE_SEPARATOR_CHARACTERS = 2;
const SKIPPED_GRAPH_LIMIT = 20;
const WORD = /[\p{L}\p{M}\p{N}_]/u;
const TOKEN = /[\p{L}\p{M}\p{N}_]+|[^\p{L}\p{M}\p{N}_\s]/gu;
type GraphRecordRow = { id: number; name: string; type: string | null; source: number | null; target: number | null;
  strength: number | null; characters: number };
type Neighbor = { entityId: number; relationshipId: number; strength: number };
type EntityName = { name: string; id: number };
type IndexedRecord = { name: string; type: string | null; characters: number; endpoints?: [number, number]; vectorOffset?: number };


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

function attachRecord(records: Map<number, IndexedRecord>, names: Map<string, EntityName[]>,
  adjacency: Map<number, Neighbor[]>, row: GraphRecordRow, vectorOffset: number) {
  if (row.type !== null) {
    const name = normalizedName(row.name);
    const first = name.match(TOKEN)?.[0];
    if (first) {
      const candidates = names.get(first) ?? [];
      candidates.push({ name, id: row.id });
      names.set(first, candidates);
    }
    records.set(row.id, { name: row.name, type: row.type, characters: row.characters });
    return;
  }
  const source = row.source!;
  const target = row.target!;
  const strength = row.strength!;
  records.set(row.id, { name: row.name, type: row.type, characters: row.characters, endpoints: [source, target], vectorOffset });
  for (const [from, to] of [[source, target], [target, source]]) {
    const neighbors = adjacency.get(from) ?? [];
    neighbors.push({ entityId: to, relationshipId: row.id, strength });
    adjacency.set(from, neighbors);
  }
}

function findNameMatches(queryText: string, names: Map<string, EntityName[]>) {
  const matches = new Set<number>();
  const text = normalizedName(queryText);
  for (const token of text.matchAll(TOKEN)) {
    const precedingCharacter = Array.from(text.slice(Math.max(0, token.index - 2), token.index)).at(-1);
    if (precedingCharacter && WORD.test(precedingCharacter)) continue;
    for (const candidate of names.get(token[0]) ?? []) {
      if (!text.startsWith(candidate.name, token.index)) continue;
      const followingCodePoint = text.codePointAt(token.index + candidate.name.length);
      if (followingCodePoint === undefined || !WORD.test(String.fromCodePoint(followingCodePoint))) matches.add(candidate.id);
    }
  }
  return matches;
}

function createSearch() {
  const index = new VectorIndex(dimensions);
  const records = new Map<number, IndexedRecord>();
  const names = new Map<string, EntityName[]>();
  const adjacency = new Map<number, Neighbor[]>();
  let entities = 0;
  let relationships = 0;
  const rows = db.prepare("SELECT id, name, type, source, target, strength, characters FROM graph_records WHERE generation = ? ORDER BY id")
    .iterate(generation) as Iterable<GraphRecordRow>;
  for (const row of rows) {
    attachRecord(records, names, adjacency, row, relationships);
    if (row.type === null) relationships++;
    else entities++;
  }
  for (const [id, neighbors] of adjacency) {
    neighbors.sort((a, b) => b.strength - a.strength || a.relationshipId - b.relationshipId);
    if (neighbors.length > MAX_EDGES_PER_ENTITY) adjacency.set(id, neighbors.slice(0, MAX_EDGES_PER_ENTITY));
  }
  index.view(paths, entities, relationships);

  return (query: GraphQuery): GraphContext => {
    const included = new Map<number, { reason: string; hop: number }>();
    const rejected = new Map<number, { reason: string; hop: number; excluded_reason: string }>();
    const visitedEntities = new Set<number>();
    const relationshipScores = new Map<number, number>();
    const queryVector = Float32Array.from(query.vector);
    const queryVectorLength = Math.sqrt(queryVector.reduce((sum, value) => sum + value * value, 0));
    let remainingCharacters = query.graph_budget;

    function skip(id: number, reason: string, hop: number, excluded: string) {
      if (!included.has(id) && !rejected.has(id)) rejected.set(id, { reason, hop, excluded_reason: excluded });
    }

    function tryIncludeRecord(id: number, reason: string, hop = 0) {
      if (included.has(id)) return false;
      const record = records.get(id);
      if (!record) return false;
      const separatorCharacters = included.size ? NOTE_SEPARATOR_CHARACTERS : 0;
      const addedCharacters = record.characters + separatorCharacters;
      if (addedCharacters > remainingCharacters) {
        skip(id, reason, hop, "budget full");
        return false;
      }
      rejected.delete(id);
      included.set(id, { reason, hop });
      remainingCharacters -= addedCharacters;
      return true;
    }

    function scoreRelationship(neighbor: Neighbor) {
      const relationshipId = neighbor.relationshipId;
      const cachedScore = relationshipScores.get(relationshipId);
      if (cachedScore !== undefined) return cachedScore;

      const relationshipVector = index.get_vector(records.get(relationshipId)!.vectorOffset!);
      let dotProduct = 0;
      let relationshipLengthSquared = 0;
      for (let i = 0; i < queryVector.length; i++) {
        const coordinate = relationshipVector[i];
        dotProduct += coordinate * queryVector[i];
        relationshipLengthSquared += coordinate * coordinate;
      }
      const similarity = relationshipLengthSquared && queryVectorLength
        ? dotProduct / (Math.sqrt(relationshipLengthSquared) * queryVectorLength)
        : 0;
      const strengthScore = EDGE_STRENGTH_WEIGHT * neighbor.strength / MAX_RELATIONSHIP_STRENGTH;
      const score = EDGE_SIMILARITY_WEIGHT * similarity + strengthScore;
      relationshipScores.set(relationshipId, score);
      return score;
    }

    const exactMatches = findNameMatches(query.text, names);
    const candidateLimit = Math.min(records.size, query.graph_matches * SEED_CANDIDATES_PER_MATCH);
    const semanticMatches = index.search(queryVector, candidateLimit);
    const seeds: number[] = [];
    for (const id of [...exactMatches, ...semanticMatches.map(hit => hit.id)]) {
      const reason = exactMatches.has(id) ? "Exact match" : "Meaning match";
      if (seeds.length >= query.graph_matches) skip(id, reason, 0, "match limit reached");
      else if (tryIncludeRecord(id, reason)) seeds.push(id);
    }

    let frontier: number[] = [];
    let seedRelationships: number[] = [];
    for (const seed of seeds) {
      if (records.get(seed)!.endpoints) seedRelationships.push(seed);
      else {
        visitedEntities.add(seed);
        frontier.push(seed);
      }
    }

    for (let hop = 0; hop < query.graph_hops && (frontier.length || seedRelationships.length) && remainingCharacters > 0; hop++) {
      const nextEntityRanks = new Map<number, number>();
      const reason = `Hop ${hop + 1}`;
      function visitEntity(entityId: number, rank: number) {
        if (visitedEntities.has(entityId)) return;
        if (tryIncludeRecord(entityId, reason, hop + 1) || included.has(entityId)) {
          const previousRank = nextEntityRanks.get(entityId) ?? -Infinity;
          nextEntityRanks.set(entityId, Math.max(rank, previousRank));
        }
      }

      for (const relationshipId of seedRelationships) {
        for (const entityId of records.get(relationshipId)!.endpoints!) visitEntity(entityId, 1);
      }
      seedRelationships = [];
      for (const entityId of frontier) {
        const neighbors = (adjacency.get(entityId) ?? []).map(neighbor => ({ neighbor, rank: scoreRelationship(neighbor) }))
          .sort((left, right) => right.rank - left.rank || left.neighbor.relationshipId - right.neighbor.relationshipId);
        let acceptedRelationships = 0;
        for (const { neighbor, rank } of neighbors) {
          if (acceptedRelationships >= query.graph_edges) {
            skip(neighbor.relationshipId, reason, hop + 1, "edge limit reached");
            continue;
          }
          const addedRelationship = tryIncludeRecord(neighbor.relationshipId, reason, hop + 1);
          const neighborAlreadyReached = visitedEntities.has(neighbor.entityId) || nextEntityRanks.has(neighbor.entityId);
          const canFollowSelectedRelationship = !neighborAlreadyReached && included.has(neighbor.relationshipId);
          if (!addedRelationship && !canFollowSelectedRelationship) continue;
          acceptedRelationships++;
          visitEntity(neighbor.entityId, rank);
        }
      }
      for (const entityId of nextEntityRanks.keys()) visitedEntities.add(entityId);
      const rankedEntities = [...nextEntityRanks].sort(([leftId, leftRank], [rightId, rightRank]) => rightRank - leftRank || leftId - rightId);
      frontier = rankedEntities.slice(0, MAX_ENTITIES_PER_HOP).map(([entityId]) => entityId);
    }

    const skipped = [...rejected.keys()].slice(0, SKIPPED_GRAPH_LIMIT);
    const shown = [...included.keys(), ...skipped];
    const rows = db.prepare(`
      SELECT id, description FROM graph_records
      WHERE generation = ? AND id IN (SELECT value FROM json_each(?))
    `).all(generation, JSON.stringify(shown)) as { id: number; description: string }[];
    const descriptions = new Map(rows.map(row => [row.id, row.description]));
    const endpoints = new Map<number, GraphEndpoint>();
    const trace: GraphTrace[] = shown.map(id => {
      const { name, type, endpoints: link } = records.get(id)!;
      for (const endpoint of link ?? []) {
        const node = records.get(endpoint)!;
        endpoints.set(endpoint, { id: endpoint, name: node.name, type: node.type });
      }
      return {
        id, name, type, description: descriptions.get(id)!, source: link?.[0], target: link?.[1],
        ...(included.get(id) ?? rejected.get(id)!), included: included.has(id),
      };
    });
    const notes = Array.from(included.keys(), id => {
      const { name, type } = records.get(id)!;
      return graphRecordTitle(name, type) + "\n" + descriptions.get(id)!;
    });
    return { entities, relationships, notes, trace, endpoints: [...endpoints.values()], other_skipped: rejected.size - skipped.length };
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
