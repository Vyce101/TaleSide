import { randomUUID } from "node:crypto";

export class RequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function makeId() { return randomUUID().replaceAll("-", ""); }

export function identifier(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new RequestError("Invalid ID.");
  return value;
}

export function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError("Expected an object.");
  return value as Record<string, unknown>;
}

export function requiredText(value: unknown, message: string, max = Infinity) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new RequestError(message);
  return value.trim();
}

export function whole(value: unknown, min: number, message: string, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new RequestError(message);
  return value;
}
