export function nowIso(): string {
  return new Date().toISOString();
}

export function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

export function safeSnippet(text: string | undefined) {
  const value = text?.replace(/\s+/g, " ").trim() ?? "";
  if (!value || value.length < 12) return undefined;
  return value.length > 280 ? `${value.slice(0, 277).trim()}...` : value;
}

export function countBy<T extends string>(values: T[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

export function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}
