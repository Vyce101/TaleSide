import type { DatabaseSync } from "node:sqlite";
import type { Persona, PersonasView } from "../shared/types.js";
import { all, get, run, transaction } from "./sqlite.js";
import { identifier, makeId, RequestError, requiredText } from "./validation.js";
import type { Artwork } from "./artwork.js";

type PersonaRow = Omit<Persona, "artwork"> & { portrait: string | null };
const user: Persona = { id: "user", name: "User", nickname: "Default", description: "", artwork: null };

export class Personas {
  constructor(private db: DatabaseSync) {}

  private viewRow({ portrait, ...persona }: PersonaRow): Persona {
    return { ...persona, artwork: portrait ? `/api/persona-artwork/${portrait}` : null };
  }

  require(id: unknown) {
    if (id === "user") return user;
    const row = get<PersonaRow>(this.db, "SELECT * FROM personas WHERE id = ?", identifier(id));
    if (!row) throw new RequestError("This Persona could not be found.", 404);
    return this.viewRow(row);
  }

  private assigned(scope: string) {
    return get<{ persona_id: string }>(this.db, "SELECT persona_id FROM persona_defaults WHERE scope = ?", scope)?.persona_id ?? null;
  }

  view(world: string | null): PersonasView {
    const rows = all<PersonaRow>(this.db, "SELECT * FROM personas ORDER BY name COLLATE NOCASE, id");
    return { personas: [user, ...rows.map(row => this.viewRow(row))], global: this.assigned("global"),
      world: world ? this.assigned(world) : null };
  }

  resolve(world: string, selection?: string | null): Persona {
    if (selection === "user") return user;
    const saved = selection && get<PersonaRow>(this.db, "SELECT * FROM personas WHERE id = ?", selection);
    if (saved) return this.viewRow(saved);
    return this.require(this.assigned(world) ?? this.assigned("global") ?? "user");
  }

  change(action: string, input: Record<string, unknown>) {
    if (action === "create") {
      const id = makeId();
      run(this.db, "INSERT INTO personas (id, name) VALUES (?, 'New Persona')", id);
      return this.require(id);
    }
    const id = identifier(input.id);
    this.require(id);
    if (action === "delete") {
      return transaction(this.db, () => {
        run(this.db, "UPDATE tales SET persona_id = NULL WHERE persona_id = ?", id);
        run(this.db, "DELETE FROM personas WHERE id = ?", id);
        this.removeUnusedPortraits();
        return { ok: true };
      });
    }
    if (action === "default") {
      const scope = input.world === null ? "global" : identifier(input.world);
      if (scope !== "global" && !get(this.db, "SELECT 1 FROM worlds WHERE id = ?", scope)) {
        throw new RequestError("This World could not be found.", 404);
      }
      if (input.enabled === true) run(this.db, `
        INSERT INTO persona_defaults (scope, persona_id) VALUES (?, ?)
        ON CONFLICT(scope) DO UPDATE SET persona_id = excluded.persona_id
      `, scope, id);
      else if (input.enabled === false) run(this.db, "DELETE FROM persona_defaults WHERE scope = ? AND persona_id = ?", scope, id);
      else throw new RequestError("Choose whether to use this Persona by default.");
      return { ok: true };
    }
    switch (input.field) {
      case "name":
        run(this.db, "UPDATE personas SET name = ? WHERE id = ?", requiredText(input.value, "Enter a Persona name.", 100), id);
        break;
      case "nickname":
      case "description": {
        if (typeof input.value !== "string") throw new RequestError("Enter text for this field.");
        run(this.db, `UPDATE personas SET ${input.field} = ? WHERE id = ?`, input.value, id);
        break;
      }
      default: throw new RequestError("Choose a Persona field.");
    }
    return this.require(id);
  }

  portrait(id: string, artwork: Artwork) {
    this.require(id);
    const portrait = makeId();
    transaction(this.db, () => {
      run(this.db, "INSERT INTO persona_artwork VALUES (?, ?, ?)", portrait, artwork.content_type, artwork.image);
      run(this.db, "UPDATE personas SET portrait = ? WHERE id = ?", portrait, id);
      this.removeUnusedPortraits();
    });
    return this.require(id);
  }

  private removeUnusedPortraits() {
    run(this.db, `
      DELETE FROM persona_artwork AS a WHERE NOT EXISTS (SELECT 1 FROM personas WHERE portrait = a.id)
        AND NOT EXISTS (SELECT 1 FROM tale_messages WHERE player_artwork = '/api/persona-artwork/' || a.id)
    `);
  }

  artwork(id: string) {
    return get<Artwork>(this.db, "SELECT content_type, image FROM persona_artwork WHERE id = ?", id);
  }
}
