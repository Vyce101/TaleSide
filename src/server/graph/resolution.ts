import { createHash } from "node:crypto";
import { entityIdentity, type Endpoint, type Extraction } from "./records.js";

type Note = { book: number; chunk: number; description: string };
type Entity = Endpoint & { notes: Note[] };
type Edge = { source: string; target: string; strength: number; notes: Note[] };
export type GraphInput = { identity: string; name: string; type?: string; source?: string; target?: string; strength?: number;
  input: string; fingerprint: string; descriptions: number };

export function resolveGraph(passes: Iterable<{ book: number; chunk: number; records: string }>): GraphInput[] {
  const entities = new Map<string, Entity>();
  const edges = new Map<string, Edge>();
  const relationships: { record: Extract<Extraction, { kind: "relationship" }>; note: Note }[] = [];
  for (const { book, chunk, records } of passes) {
    for (const record of JSON.parse(records) as Extraction[]) {
      const note = { book, chunk, description: record.description };
      if (record.kind === "relationship") {
        relationships.push({ record, note });
        continue;
      }
      const id = entityIdentity(record);
      if (!entities.has(id)) entities.set(id, { name: record.name, type: record.type, notes: [] });
      entities.get(id)!.notes.push(note);
    }
  }
  for (const { record, note } of relationships) {
    const source = entityIdentity(record.source);
    const target = entityIdentity(record.target);
    if (source === target) {
      entities.get(source)!.notes.push(note);
      continue;
    }
    const id = JSON.stringify([source, target]);
    if (!edges.has(id)) edges.set(id, { source, target, strength: record.strength, notes: [] });
    const edge = edges.get(id)!;
    edge.strength = Math.max(edge.strength, record.strength);
    edge.notes.push(note);
  }
  function description(name: string, type: string, notes: Note[]) {
    notes.sort((a, b) => a.book - b.book || a.chunk - b.chunk);
    const unique = new Set(notes.map(note => `B${note.book}:C${note.chunk}: ${note.description}`));
    const input = [...unique].join("\n\n");
    return { input, descriptions: unique.size,
      fingerprint: createHash("sha256").update(JSON.stringify([name, type, input])).digest("hex") };
  }
  return [
    ...Array.from(entities, ([identity, { name, type, notes }]) => ({ identity, name, type, ...description(name, type, notes) })),
    ...Array.from(edges, ([identity, { source, target, strength, notes }]) => {
      const name = `${entities.get(source)!.name} → ${entities.get(target)!.name}`;
      return { identity, name, source, target, strength, ...description(name, "relationship", notes) };
    }),
  ];
}
