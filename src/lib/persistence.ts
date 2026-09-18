import { invoke } from "@tauri-apps/api/core";

let queue: Promise<unknown> = Promise.resolve();

export function persist(key: string, value: unknown): Promise<void> {
  const snapshot = JSON.parse(JSON.stringify(value));
  const task = queue
    .catch(() => undefined)
    .then(() => invoke<void>("storage_write", { key, value: snapshot }));
  queue = task;
  return task;
}

export async function migrateStorage<T>(key: string, legacy: T): Promise<T> {
  const existing = await invoke<T | null>("storage_read", { key });
  if (existing !== null) return existing;
  await persist(key, legacy);
  return legacy;
}
