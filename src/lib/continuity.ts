export type ContinuityEntry = { text: string; targetKey: string; at: number };
export function previousContext(entry: ContinuityEntry | null, targetKey: string | undefined, text: string, now: number, enabled: boolean): string | undefined {
  if (!enabled || !entry || !targetKey || entry.targetKey !== targetKey || now < entry.at || now - entry.at > 30_000) return;
  if (/^(?:换个话题|换一个话题|新话题|另外一件事|new topic|unrelated)/iu.test(text.trim())) return;
  return Array.from(entry.text).slice(-400).join("");
}
