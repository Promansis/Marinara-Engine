import type { LtmScope } from "../schemas/long-term-memory.schema.js";

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

export function getLtmScopeChatIds(scope: Pick<LtmScope, "chatId" | "chatIds"> | null | undefined): string[] {
  return uniqueStrings([scope?.chatId, ...(scope?.chatIds ?? [])]);
}

export function withMergedLtmScopeLinks(
  scope: LtmScope | null | undefined,
  links: { chatIds?: string[]; characterIds?: string[] },
): LtmScope {
  const next: LtmScope = { ...(scope ?? {}) };
  const chatIds = uniqueStrings([...getLtmScopeChatIds(next), ...(links.chatIds ?? [])]);
  const characterIds = uniqueStrings([...(next.characterIds ?? []), ...(links.characterIds ?? [])]);

  if (chatIds.length > 0) {
    next.chatIds = chatIds;
    next.chatId = chatIds[0];
  } else {
    delete next.chatIds;
    delete next.chatId;
  }

  if (characterIds.length > 0) {
    next.characterIds = characterIds;
  } else {
    delete next.characterIds;
  }

  return next;
}
