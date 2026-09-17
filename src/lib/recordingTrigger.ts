export type TriggerOperation = "dictate" | "edit";
export type TriggerMode = "toggle" | "hold";
export class RecordingTrigger {
  private held = new Set<TriggerOperation>();
  private owner?: TriggerOperation;
  isHolding(operation: TriggerOperation) { return this.owner === operation && this.held.has(operation); }
  cancel() { this.owner = undefined; }
  handle(operation: TriggerOperation, state: "Pressed" | "Released", mode: TriggerMode, recording: boolean, busy: boolean): "start" | "finish" | undefined {
    if (state === "Released") {
      this.held.delete(operation);
      if (this.owner === operation) { this.owner = undefined; return recording ? "finish" : undefined; }
      return;
    }
    if (this.held.has(operation)) return;
    this.held.add(operation);
    if (mode === "toggle" && recording) return "finish";
    if (recording || busy) return;
    if (mode === "hold") this.owner = operation;
    return "start";
  }
}

export async function replaceShortcuts(oldKeys: string[], nextKeys: string[], add: (key: string) => Promise<void>, remove: (key: string) => Promise<void>) {
  const added: string[] = [];
  try {
    for (const key of nextKeys.filter((key) => !oldKeys.includes(key))) { await add(key); added.push(key); }
  } catch (error) {
    for (const key of added) await remove(key).catch(() => undefined);
    throw error;
  }
  const removed: string[] = [];
  try {
    for (const key of oldKeys.filter((key) => !nextKeys.includes(key))) { await remove(key); removed.push(key); }
  } catch (error) {
    for (const key of removed) await add(key).catch(() => undefined);
    for (const key of added) await remove(key).catch(() => undefined);
    throw error;
  }
}
