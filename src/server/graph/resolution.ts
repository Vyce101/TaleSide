import { createHash } from "node:crypto";
import { entityIdentity, type Endpoint, type Extraction } from "./records.js";

type Note = { book: number; chunk: number; description: string };
type Entity = Endpoint & { notes: Note[] };
type Edge = { source: string; target: string; strength: number; notes: Note[] };
type Pass = { book: number; chunk: number; records: string };
export type GraphInput = { identity: string; name: string; type?: string; source?: string; target?: string; strength?: number;
  input: string; fingerprint: string; descriptions: number };

export class GraphResolution {
  private entities = new Map<string, Entity>();
  private edges = new Map<string, Edge>();
  private selfNotes = new Map<string, Note[]>();

  add({ book, chunk, records }: Pass) {
    for (const record of JSON.parse(records) as Extraction[]) {
      const note = { book, chunk, description: record.description };
      if (record.kind === "entity") {
        const id = entityIdentity(record);
        if (!this.entities.has(id)) this.entities.set(id, { name: record.name, type: record.type, notes: [] });
        this.entities.get(id)!.notes.push(note);
        continue;
      }
      const source = entityIdentity(record.source);
      const target = entityIdentity(record.target);
      if (source === target) {
        if (!this.selfNotes.has(source)) this.selfNotes.set(source, []);
        this.selfNotes.get(source)!.push(note);
        continue;
      }
      const id = JSON.stringify([source, target]);
      if (!this.edges.has(id)) this.edges.set(id, { source, target, strength: record.strength, notes: [] });
      const edge = this.edges.get(id)!;
      edge.strength = Math.max(edge.strength, record.strength);
      edge.notes.push(note);
    }
  }

  get counts() { return { entities: this.entities.size, relationships: this.edges.size }; }

  *records() {
    for (const [id, { name, type, notes }] of this.entities) {
      const selfNotes = this.selfNotes.get(id);
      yield { id, name, type, notes: selfNotes ? [...notes, ...selfNotes] : notes };
    }
    for (const [id, edge] of this.edges) {
      const { source, target } = edge;
      const from = this.entities.get(source);
      const to = this.entities.get(target);
      if (from && to) yield { id, name: `${from.name} → ${to.name}`, type: null, ...edge };
    }
  }
}

export function rawGraphNotes(notes: Note[]) {
  const ordered = [...notes].sort((a, b) => a.book - b.book || a.chunk - b.chunk);
  return [...new Set(ordered.map(note => `B${note.book}:C${note.chunk}: ${note.description}`))];
}

export function resolveGraph(passes: Iterable<Pass>): GraphInput[] {
  const resolution = new GraphResolution();
  for (const pass of passes) resolution.add(pass);
  return Array.from(resolution.records(), record => {
    const { id: identity, name, type, notes } = record;
    const descriptions = rawGraphNotes(notes);
    const input = descriptions.join("\n\n");
    const fingerprint = createHash("sha256").update(JSON.stringify([name, type ?? "relationship", input])).digest("hex");
    const shape = "source" in record ? { source: record.source, target: record.target, strength: record.strength }
      : { type: type! };
    return { identity, name, ...shape, input, fingerprint, descriptions: descriptions.length };
  });
}
