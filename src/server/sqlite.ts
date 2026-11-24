import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export function get<T>(db: DatabaseSync, sql: string, ...args: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...args) as T | undefined;
}

export function all<T>(db: DatabaseSync, sql: string, ...args: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...args) as T[];
}

export function run(db: DatabaseSync, sql: string, ...args: SQLInputValue[]) {
  return db.prepare(sql).run(...args);
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
