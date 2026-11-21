import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { KeyImpact, KeySettings } from "../shared/types.js";
import { all, get, run, saveSelection, selectedKeys, transaction } from "./database.js";
import { EMBEDDING_MODEL, EMBEDDING_MODELS } from "./gemini.js";
import { identifier, makeId, RequestError, requiredText } from "./validation.js";

type Key = { id: string; nickname: string; suffix: string | null; protected_secret: Uint8Array };
type Purpose = "embedding" | "retrieval" | "chat";
const INDEX_KEY_COOLDOWN_MS = 30_000;

type Protector = (operation: "Protect" | "Unprotect", input: Uint8Array) => Buffer;
const script = fileURLToPath(new URL("../../scripts/protect-key.ps1", import.meta.url));

function maskedEnding(secret: string) { return secret.length > 4 ? secret.slice(-4) : ""; }

export const EMBEDDING_KEY_REQUIRED = "Choose at least one saved Google AI Studio key.";
export function dpapi(operation: "Protect" | "Unprotect", input: Uint8Array) {
  const process = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, "-Operation", operation],
    { input: Buffer.from(input).toString("base64"), encoding: "utf8", windowsHide: true, timeout: 15000 });
  if (process.status !== 0 || !process.stdout?.trim()) {
    throw new RequestError(operation === "Protect" ? "Windows could not protect the API key."
      : "Could not open this API key. Replace it in API Keys.", 409);
  }
  return Buffer.from(process.stdout.trim(), "base64");
}

export class ProviderKeys {
  private rotation = new Map<string, number>();
  private secrets = new Map<string, string>();
  private unavailableSuffixes = new Set<string>();

  constructor(private db: DatabaseSync, private protect: Protector = dpapi) {}

  private require(id: string) {
    const key = get<Key>(this.db, "SELECT * FROM provider_keys WHERE id = ? AND provider = 'gemini'", id);
    if (!key) throw new RequestError("Choose a saved Google AI Studio key.", 409);
    return key;
  }

  validate(selection: unknown, required = false) {
    if (!Array.isArray(selection)) throw new RequestError("Provide a list of saved key IDs.");
    const ids = selection.map(identifier);
    if (ids.length !== new Set(ids).size) throw new RequestError("Select each key only once.");
    if (required && !ids.length) throw new RequestError(EMBEDDING_KEY_REQUIRED, 409);
    ids.forEach(id => this.require(id));
    return ids;
  }

  private secret(key: Key) {
    let secret = this.secrets.get(key.id);
    if (!secret) {
      secret = this.protect("Unprotect", key.protected_secret).toString("utf8");
      this.secrets.set(key.id, secret);
    }
    return secret;
  }

  *attempts(purpose: Purpose, ids: string[], signal: AbortSignal, cooldown?: Map<string, number>) {
    if (!ids.length) throw new RequestError(EMBEDDING_KEY_REQUIRED, 409);
    const selection = purpose + ids.join(",");
    const attempted = new Set<string>();
    while (attempted.size < ids.length) {
      signal.throwIfAborted();
      const start = this.rotation.get(selection) ?? 0;
      const ordered = [...ids.slice(start), ...ids.slice(0, start)].filter(id => !attempted.has(id));
      const id = ordered.find(candidate => (cooldown?.get(candidate) ?? 0) <= performance.now()) ?? ordered[0];
      attempted.add(id);
      this.rotation.set(selection, (ids.indexOf(id) + 1) % ids.length);
      yield { id, key: this.secret(this.require(id)), last: attempted.size === ids.length };
    }
  }

  async retry<T>(purpose: Purpose, ids: string[], signal: AbortSignal, request: (key: string) => Promise<T>,
    indexing?: { cooldown: Map<string, number>; paused: () => boolean }) {
    const failed: string[] = [];
    for (const { id, key, last } of this.attempts(purpose, ids, signal, indexing?.cooldown)) {
      try {
        const response = await request(key);
        signal.throwIfAborted();
        if (indexing) {
          indexing.cooldown.delete(id);
          for (const failedId of failed) indexing.cooldown.set(failedId, performance.now() + INDEX_KEY_COOLDOWN_MS);
        }
        return response;
      } catch (error) {
        if (last || signal.aborted || indexing?.paused()) throw error;
        failed.push(id);
      }
    }
    throw new RequestError(EMBEDDING_KEY_REQUIRED, 409);
  }

  private assignments(id: string) {
    return all<{ id: string; name: string; busy: number }>(this.db, `
      SELECT w.id, w.name, (w.status IN ('creating', 'pausing') AND EXISTS (
        SELECT 1 FROM world_embedding_keys WHERE owner_id = w.id AND key_id = ?
      )) AS busy
      FROM worlds w WHERE w.status <> 'draft' AND (
        EXISTS (SELECT 1 FROM world_embedding_keys WHERE owner_id = w.id AND key_id = ?)
        OR EXISTS (SELECT 1 FROM world_retrieval_keys WHERE owner_id = w.id AND key_id = ?)
      ) ORDER BY w.rowid
    `, id, id, id);
  }

  impact(id: string): KeyImpact {
    this.require(id);
    const assignments = this.assignments(id);
    return { worlds: assignments.map(({ id, name }) => ({ id, name })), busy: assignments.some(world => world.busy) };
  }

  settings(): KeySettings {
    const keys = all<Key>(this.db, "SELECT * FROM provider_keys WHERE provider = 'gemini' ORDER BY rowid").map(key => {
      let suffix = key.suffix;
      if (suffix === null && !this.unavailableSuffixes.has(key.id)) {
        try {
          suffix = maskedEnding(this.secret(key));
          run(this.db, "UPDATE provider_keys SET suffix = ? WHERE id = ?", suffix, key.id);
        } catch { this.unavailableSuffixes.add(key.id); }
      }
      return { id: key.id, nickname: key.nickname, suffix, worlds: this.impact(key.id).worlds };
    });
    const defaults = get<{ model: string }>(this.db, "SELECT model FROM embedding_defaults WHERE id = 1");
    return { keys, models: EMBEDDING_MODELS.filter(model => model.id === EMBEDDING_MODEL), defaults: defaults
      ? { model: EMBEDDING_MODEL, key_ids: selectedKeys(this.db, "embedding_default_keys", 1) }
      : { model: EMBEDDING_MODEL, key_ids: keys.slice(0, 1).map(key => key.id) } };
  }

  remember(model: string, keyIds: string[]) {
    run(this.db, "INSERT INTO embedding_defaults (id, model) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET model = excluded.model", model);
    saveSelection(this.db, "embedding_default_keys", 1, keyIds);
  }

  private name(value: unknown, id: string) {
    const nickname = requiredText(value, "Enter an API key name up to 60 characters.", 60);
    if (get(this.db, "SELECT 1 FROM provider_keys WHERE provider = 'gemini' AND nickname = ? COLLATE NOCASE AND id <> ?", nickname, id)) {
      throw new RequestError("An API key already has that name.", 409);
    }
    return nickname;
  }

  private encrypted(value: unknown) {
    const secret = requiredText(value, "Enter an API key up to 512 characters.", 512);
    if (!/^[!-~]+$/.test(secret)) throw new RequestError("Enter a key without spaces or control characters.");
    return { cipher: this.protect("Protect", Buffer.from(secret)), suffix: maskedEnding(secret) };
  }

  add(name: unknown, value: unknown) {
    const id = makeId();
    const nickname = this.name(name, id);
    const { cipher, suffix } = this.encrypted(value);
    run(this.db, "INSERT INTO provider_keys (id, provider, nickname, protected_secret, suffix) VALUES (?, 'gemini', ?, ?, ?)",
      id, nickname, cipher, suffix);
    return { id, nickname };
  }

  rename(id: string, name: unknown) {
    this.require(id);
    run(this.db, "UPDATE provider_keys SET nickname = ? WHERE id = ?", this.name(name, id), id);
  }

  replace(id: string, value: unknown) {
    if (this.impact(id).busy) throw new RequestError("Pause Worlds using this key before replacing it.", 409);
    const { cipher, suffix } = this.encrypted(value);
    run(this.db, "UPDATE provider_keys SET protected_secret = ?, suffix = ? WHERE id = ?", cipher, suffix, id);
    this.secrets.delete(id);
    this.unavailableSuffixes.delete(id);
  }

  delete(id: string, confirmed: unknown) {
    transaction(this.db, () => {
      const impact = this.impact(id);
      if (impact.busy) throw new RequestError("Pause Worlds using this key before deleting it.", 409);
      if (JSON.stringify(confirmed) !== JSON.stringify(impact)) {
        throw new RequestError("Key usage changed. Review the confirmation again.", 409);
      }
      run(this.db, "DELETE FROM provider_keys WHERE id = ?", id);
    });
    this.secrets.delete(id);
    this.unavailableSuffixes.delete(id);
  }
}
