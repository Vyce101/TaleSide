import type { KeySettings, TaleSummary, World } from "../shared/types.js";

export let worlds: World[] = [];
export let tales: TaleSummary[] = [];
export let keySettings: KeySettings = { keys: [], models: [], defaults: { model: "gemini-embedding-2", key_ids: [] } };
let worldVersion = 0;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function request<T>(route: string, input?: object, signal?: AbortSignal): Promise<T> {
  const response = input === undefined ? await fetch(route, { cache: "no-store", signal }) : await post(route, input, { signal });
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<T>;
}

export function post(route: string, input: object, options?: { signal?: AbortSignal; keepalive?: boolean }) {
  const payload = input instanceof FormData ? { body: input }
    : { body: JSON.stringify(input), headers: { "Content-Type": "application/json" } };
  return fetch(route, { ...options, ...payload, method: "POST", cache: "no-store" });
}

export async function apiError(response: Response) {
  const body = await response.json().catch(() => null);
  return new ApiError(body?.error ?? "TaleSide could not complete the request.", response.status);
}

export function newId() { return crypto.randomUUID().replaceAll("-", ""); }
export function worldRoute(id: string) { return `/api/worlds/${id}`; }
export function taleRoute(tale: Pick<TaleSummary, "world_id" | "id">) { return worldRoute(tale.world_id) + `/tales/${tale.id}`; }

export async function loadWorlds() {
  const version = worldVersion;
  const result = await request<World[]>("/api/worlds");
  if (version === worldVersion) worlds = result;
  return worlds;
}

export function storeWorld(world: World) {
  worldVersion++;
  const index = worlds.findIndex(item => item.id === world.id);
  if (index === -1) worlds.unshift(world);
  else worlds[index] = world;
}

export function removeWorld(id: string) {
  worldVersion++;
  worlds = worlds.filter(world => world.id !== id);
  tales = tales.filter(tale => tale.world_id !== id);
}

export async function loadTales() { tales = await request<TaleSummary[]>("/api/tales"); }

export function storeTale(tale: TaleSummary) {
  const index = tales.findIndex(item => item.id === tale.id);
  if (index === -1) tales.push(tale);
  else tales[index] = tale;
}

export function removeTale(id: string) { tales = tales.filter(tale => tale.id !== id); }

export async function loadKeys() { keySettings = await request<KeySettings>("/api/settings"); }

export function orderedTales(world?: World) {
  return tales.filter(tale => !world || tale.world_id === world.id)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || recentTime(b) - recentTime(a));
}

export function recentTime(tale: TaleSummary) { return tale.last_activity_at ?? tale.created_at; }
