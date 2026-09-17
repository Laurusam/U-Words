/** Remove only unambiguous sentence-final periods, without mutating ASR evidence. */
export function finalizeDictationText(text: string): string {
  const trimmed = text.trimEnd();
  const line = trimmed.split("\n").at(-1) || "";
  if (/^(?:\s{4}|```|[$>] )/.test(line) || line.includes("`")) return trimmed;
  if (trimmed.endsWith("。")) return trimmed.replace(/。+$/u, "");
  if (!trimmed.endsWith(".") || trimmed.endsWith("..")) return trimmed;
  const token = line.match(/([^\s]+)\.$/u)?.[1];
  if (!token || /[.\/@\\:=_]/u.test(token) || /^\d+$/u.test(token)) return trimmed;
  if (/^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|etc|vs|Inc|Ltd|Co)$/iu.test(token)) return trimmed;
  if (!/^[\p{L}\p{M}'’\-]+$/u.test(token)) return trimmed;
  return trimmed.slice(0, -1);
}
