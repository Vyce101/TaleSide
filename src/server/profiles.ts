import { BUILTIN_PROMPTS, DEFAULT_PROMPTS } from "../shared/story-defaults.js";
import type { DatabaseSync } from "node:sqlite";
import type { BuiltinPrompt, ChatSettings, Profile, ProfileSettings, PromptBlock, Wrappers } from "../shared/types.js";
import { all, get, run, saveSelection, selectedKeys, transaction } from "./database.js";
import { CHAT_MODELS } from "../shared/models.js";
import { ProviderKeys } from "./keys.js";
import { fields, identifier, makeId, RequestError, requiredText, whole } from "./validation.js";

const DEFAULT_ID = "00000000000000000000000000000000";
const wrapperNames = Object.keys(BUILTIN_PROMPTS) as BuiltinPrompt[];
const wrappers = Object.fromEntries(wrapperNames.map(name => {
  const tag = name === "retrieved_passages" ? "retrieved_context" : name;
  return [name, [`<${tag}>`, `</${tag}>`]];
})) as Wrappers;
const [defaultModel] = CHAT_MODELS;
const defaults: ChatSettings = {
  model: defaultModel.id, chat_key_ids: [], thinking_level: defaultModel.default_thinking, thought_signatures: defaultModel.replay_thinking,
  input_limit: defaultModel.context_limit, output_limit: defaultModel.max_output, chunk_budget: 20000, graph_budget: 80000,
  graph_matches: 10, graph_hops: 1, graph_edges: 5,
  minimum_similarity: 0.15, chunk_overlap: 400, messages_to_embed: 2, wrappers, prompts: DEFAULT_PROMPTS,
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
      if (!get(db, "SELECT 1 FROM chat_profiles WHERE id = ?", DEFAULT_ID)) {
        run(db, "INSERT INTO chat_profiles (id, name, configuration) VALUES (?, 'Default', ?)", DEFAULT_ID, JSON.stringify(defaults));
      }
      if (!saved || !saved.profile_id) this.select(DEFAULT_ID);
    });
  }

  private read(row: ProfileRow): Profile {
    const stored = JSON.parse(row.configuration) as Partial<ChatSettings>;
    const locked = row.id === DEFAULT_ID;
    const model = CHAT_MODELS.find(model => model.id === stored.model) ?? defaultModel;
    const settings: ChatSettings = {
      ...defaults, ...(!locked ? stored : {}), model: model.id,
      thinking_level: stored.thinking_level && model.thinking_levels.includes(stored.thinking_level) ? stored.thinking_level : model.default_thinking,
      thought_signatures: stored.thought_signatures ?? model.replay_thinking,
      input_limit: Math.min(locked ? model.context_limit : stored.input_limit ?? model.context_limit, model.context_limit),
      output_limit: Math.min(locked ? model.max_output : stored.output_limit ?? model.max_output, model.max_output),
      wrappers: locked ? wrappers : { ...wrappers, ...stored.wrappers },
    };
    const [open, close] = settings.wrappers.retrieved_passages;
    if (open === "<retrieved_passages>" && close === "</retrieved_passages>") {
      settings.wrappers.retrieved_passages = wrappers.retrieved_passages;
    }
    if (Object.hasOwn(settings, "retrieved_chunks")) Reflect.deleteProperty(settings, "retrieved_chunks");
    return { id: row.id, name: locked ? "Default" : row.name, locked,
      settings: { ...settings, chat_key_ids: selectedKeys(this.db, "chat_profile_keys", row.id) } };
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
      profiles: available.map(row => this.read(row)), models: CHAT_MODELS, defaults };
  }

  validate(value: unknown): ChatSettings {
    const input = fields(value);
    const model = CHAT_MODELS.find(model => model.id === input.model);
    if (!model) throw new RequestError("Choose an available chat model.");
    if (typeof input.thinking_level !== "string" || !model.thinking_levels.includes(input.thinking_level)) {
      throw new RequestError("Choose a supported thinking level.");
    }
    if (typeof input.thought_signatures !== "boolean") throw new RequestError("Choose whether to send thinking.");
    if (typeof input.minimum_similarity !== "number" || !Number.isFinite(input.minimum_similarity)
      || input.minimum_similarity < 0 || input.minimum_similarity > 1) throw new RequestError("Minimum similarity must be between 0 and 1.");
    const rawWrappers = fields(input.wrappers);
    const validated = {} as Wrappers;
    for (const name of wrapperNames) {
      const pair = rawWrappers[name] ?? wrappers[name];
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== "string")) {
        throw new RequestError("Enter an opening and closing wrapper for each section.");
      }
      validated[name] = [pair[0], pair[1]];
    }
    return {
      model: model.id, chat_key_ids: this.keys.validate(input.chat_key_ids), thinking_level: input.thinking_level,
      thought_signatures: input.thought_signatures,
      input_limit: whole(input.input_limit, 256, "Enter an input limit within the model range.", model.context_limit),
      output_limit: whole(input.output_limit, 256, "Enter an output limit within the model range.", model.max_output),
      chunk_budget: whole(input.chunk_budget ?? defaults.chunk_budget, 1, "Enter a positive Chunk RAG character budget."),
      graph_budget: whole(input.graph_budget ?? defaults.graph_budget, 1, "Enter a positive Graph RAG character budget."),
      graph_matches: whole(input.graph_matches ?? defaults.graph_matches, 1, "Enter at least one first graph match."),
      graph_hops: whole(input.graph_hops ?? defaults.graph_hops, 0, "Enter a nonnegative number of graph hops."),
      graph_edges: whole(input.graph_edges ?? defaults.graph_edges, 1, "Enter between 1 and 150 edges per entity.", 150),
      minimum_similarity: input.minimum_similarity,
      chunk_overlap: whole(input.chunk_overlap, 0, "Enter a nonnegative chunk overlap."),
      messages_to_embed: whole(input.messages_to_embed, 1, "Enter at least one message to embed."),
      wrappers: validated, prompts: validatePrompts(input.prompts),
    };
  }

  change(action: string, input: Record<string, unknown>): ProfileSettings {
    transaction(this.db, () => {
      const id = action === "create" ? makeId() : identifier(input.id);
      const row = action === "create" ? undefined : this.require(id);
      if (id === DEFAULT_ID && (action === "delete" || action === "rename")) {
        throw new RequestError("Default cannot be renamed or deleted.");
      }
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
          const submitted = fields(input.settings);
          const model = CHAT_MODELS.find(model => model.id === submitted.model);
          const { chat_key_ids, ...settings } = this.validate(id === DEFAULT_ID ? {
            ...defaults, input_limit: model?.context_limit, output_limit: model?.max_output,
            chat_key_ids: submitted.chat_key_ids, model: submitted.model,
            thinking_level: submitted.thinking_level, thought_signatures: submitted.thought_signatures,
          } : submitted);
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

function validatePrompts(value: unknown): PromptBlock[] {
  if (value === undefined) return DEFAULT_PROMPTS;
  if (!Array.isArray(value)) throw new RequestError("Enter a list of prompt blocks.");
  const ids = new Set<string>();
  const builtins = new Set<string>();
  const blocks = value.map((entry): PromptBlock => {
    const { id, kind, enabled, name, role, text } = fields(entry);
    if (typeof id !== "string" || !id || ids.has(id) || typeof enabled !== "boolean") {
      throw new RequestError("Each prompt block needs a unique ID and an enabled state.");
    }
    ids.add(id);
    if (kind === "custom") {
      if ((role !== "system" && role !== "user" && role !== "model") || typeof text !== "string") {
        throw new RequestError("Choose a prompt role and enter prompt text.");
      }
      return { id, kind, enabled, name: requiredText(name, "Enter a prompt name.", 100), role, text };
    }
    if (typeof kind !== "string" || !Object.hasOwn(BUILTIN_PROMPTS, kind) || builtins.has(kind)) {
      throw new RequestError("Include each built-in block once.");
    }
    builtins.add(kind);
    if (role !== undefined && role !== "system" && role !== "user" && role !== "model"
      && !(kind === "chat_history" && role === "multi-role")) throw new RequestError("Choose a prompt role.");
    return { id, kind: kind as BuiltinPrompt, enabled, role };
  });
  if (builtins.size !== wrapperNames.length) throw new RequestError("Include each built-in block once.");
  return blocks;
}
