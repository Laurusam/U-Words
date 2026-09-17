export function createWriteQueue<T>(writer: (value: T) => Promise<void>): (value: T) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (value: T) => {
    const snapshot = structuredClone(value);
    const pending = tail.then(() => writer(snapshot));
    // Report failures to the caller, but do not poison subsequent writes.
    tail = pending.catch(() => undefined);
    return pending;
  };
}
