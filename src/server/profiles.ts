import type { DatabaseSync } from "node:sqlite";
import type { ChatSettings, Profile, ProfileSettings, Wrappers } from "../shared/types.js";
import { all, get, run, saveSelection, selectedKeys, transaction } from "./database.js";
import { CHAT_MODEL } from "./gemini.js";
import { ProviderKeys } from "./keys.js";
import { fields, identifier, makeId, RequestError, requiredText, whole } from "./validation.js";

const DEFAULT_ID = "00000000000000000000000000000000";
const wrapperNames = ["world_info", "retrieved_passages", "chat_history"] as const;
const wrappers = Object.fromEntries(wrapperNames.map(name => [name, [`<${name}>`, `</${name}>`]])) as Wrappers;
const defaults: ChatSettings = {
  model: CHAT_MODEL.id, chat_key_ids: [], thinking_level: "HIGH", thought_signatures: true,
  input_limit: CHAT_MODEL.context_limit, output_limit: CHAT_MODEL.max_output, retrieved_chunks: 10,
  minimum_similarity: 0.15, chunk_overlap: 400, messages_to_embed: 2, wrappers,
};

type ProfileRow = { id: string; name: string; configuration: string };
type SettingsRow = { configuration: string; profile_id: string | null };

export class Profiles {
  constructor(private db: DatabaseSync, private keys: ProviderKeys) {
    transaction(db, () => {
      const saved = get<SettingsRow>(db, "SELECT configuration, profile_id FROM tale_settings WHERE id = 1");
      const first = get<{ id: string }>(db, "SELECT id FROM chat_profiles ORDER BY rowid LIMIT 1");
      if (!first || (!saved?.profile_id && first.id !== DEFAULT_ID && !get(db, "SELECT 1 FROM chat_profiles WHERE id = ?", DEFAULT_ID))) {
        const initial = saved ? { ...defaults, ...JSON.parse(saved.configuration) } : defaults;
        run(db, "INSERT INTO chat_profiles (id, name, configuration) VALUES (?, 'Default', ?)", DEFAULT_ID, JSON.stringify(initial));
        saveSelection(db, "chat_profile_keys", DEFAULT_ID, selectedKeys(db, "tale_chat_keys", 1));
      }
      if (!saved || !saved.profile_id) this.select(DEFAULT_ID);
    });
  }

  private read(row: ProfileRow): Profile {
    return { id: row.id, name: row.name, settings: { ...defaults, ...JSON.parse(row.configuration),
      chat_key_ids: selectedKeys(this.db, "chat_profile_keys", row.id) } };
  }

  private require(id: string) {
    const row = get<ProfileRow>(this.db, "SELECT id, name, configuration FROM chat_profiles WHERE id = ?", id);
    if (!row) throw new RequestError("This chat profile no longer exists.", 409);
    return row;
  }

  private select(id: string) {
    run(this.db, `
      INSERT INTO tale_settings (id, configuration, profile_id) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id
    `, JSON.stringify(defaults), id);
  }

  view(): ProfileSettings {
    const available = all<ProfileRow>(this.db, "SELECT id, name, configuration FROM chat_profiles ORDER BY id <> ?, rowid", DEFAULT_ID);
    const saved = get<SettingsRow>(this.db, "SELECT configuration, profile_id FROM tale_settings WHERE id = 1");
    return { selected: available.some(profile => profile.id === saved?.profile_id) ? saved!.profile_id! : available[0].id,
      profiles: available.map(row => this.read(row)), models: [CHAT_MODEL], defaults };
  }

  validate(value: unknown): ChatSettings {
    const input = fields(value);
    if (input.model !== CHAT_MODEL.id) throw new RequestError("Choose an available chat model.");
    if (typeof input.thinking_level !== "string" || !CHAT_MODEL.thinking_levels.includes(input.thinking_level)) {
      throw new RequestError("Choose a supported thinking level.");
    }
    if (typeof input.thought_signatures !== "boolean") throw new RequestError("Choose whether to send thinking.");
    if (typeof input.minimum_similarity !== "number" || !Number.isFinite(input.minimum_similarity)
      || input.minimum_similarity < 0 || input.minimum_similarity > 1) throw new RequestError("Minimum similarity must be between 0 and 1.");
    const rawWrappers = fields(input.wrappers);
    const validated = {} as Wrappers;
    for (const name of wrapperNames) {
      const pair = rawWrappers[name];
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== "string")) {
        throw new RequestError("Enter an opening and closing wrapper for each section.");
      }
      validated[name] = [pair[0], pair[1]];
    }
    return {
      model: input.model, chat_key_ids: this.keys.validate(input.chat_key_ids), thinking_level: input.thinking_level,
      thought_signatures: input.thought_signatures,
      input_limit: whole(input.input_limit, 256, "Enter an input limit within the model range.", CHAT_MODEL.context_limit),
      output_limit: whole(input.output_limit, 256, "Enter an output limit within the model range.", CHAT_MODEL.max_output),
      retrieved_chunks: whole(input.retrieved_chunks, 1, "Enter at least one retrieved chunk."),
      minimum_similarity: input.minimum_similarity,
      chunk_overlap: whole(input.chunk_overlap, 0, "Enter a nonnegative chunk overlap."),
      messages_to_embed: whole(input.messages_to_embed, 1, "Enter at least one message to embed."),
      wrappers: validated,
    };
  }

  change(action: string, input: Record<string, unknown>): ProfileSettings {
    transaction(this.db, () => {
      const id = action === "create" ? makeId() : identifier(input.id);
      const row = action === "create" ? undefined : this.require(id);
      if (action === "delete") {
        const remaining = get<{ id: string }>(this.db, "SELECT id FROM chat_profiles WHERE id <> ? ORDER BY rowid LIMIT 1", id);
        if (!remaining) throw new RequestError("Keep at least one chat profile.");
        run(this.db, "DELETE FROM chat_profiles WHERE id = ?", id);
        const selected = get<SettingsRow>(this.db, "SELECT configuration, profile_id FROM tale_settings WHERE id = 1");
        if (!selected?.profile_id) this.select(remaining.id);
      } else if (action === "select") {
        this.select(id);
      } else {
        const name = action === "create" || action === "rename"
          ? requiredText(input.name, "Enter a chat profile name up to 100 characters.", 100) : row!.name;
        if (action === "rename" || action === "create") {
          if (get(this.db, "SELECT 1 FROM chat_profiles WHERE name = ? COLLATE NOCASE AND id <> ?", name, id)) {
            throw new RequestError("A chat profile already has that name.", 409);
          }
        }
        if (action === "rename") {
          run(this.db, "UPDATE chat_profiles SET name = ? WHERE id = ?", name, id);
        } else {
          const { chat_key_ids, ...settings } = this.validate(input.settings);
          run(this.db, `
            INSERT INTO chat_profiles (id, name, configuration) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET configuration = excluded.configuration
          `, id, name, JSON.stringify(settings));
          saveSelection(this.db, "chat_profile_keys", id, chat_key_ids);
          this.select(id);
        }
      }
    });
    return this.view();
  }
}
