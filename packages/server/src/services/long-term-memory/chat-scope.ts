import { withMergedLtmScopeLinks, type LtmMode, type LtmScope } from "@marinara-engine/shared";
import { ltmModeSchema } from "@marinara-engine/shared";

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

export function normalizeLtmChatCharacterIds(value: unknown) {
  if (Array.isArray(value)) return uniqueStrings(value.filter((id): id is string => typeof id === "string"));
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? uniqueStrings(parsed.filter((id): id is string => typeof id === "string"))
      : [];
  } catch {
    return value.trim() ? [value.trim()] : [];
  }
}

export function ltmModeForChatMode(mode: unknown): LtmMode {
  return ltmModeSchema.catch("roleplay").parse(mode);
}

export function resolveChatLtmScope(chat: {
  id: string;
  groupId?: string | null;
  characterIds?: unknown;
}) {
  const characterIds = normalizeLtmChatCharacterIds(chat.characterIds);
  return withMergedLtmScopeLinks(
    {
      chatId: chat.id,
      ...(chat.groupId ? { groupId: chat.groupId } : {}),
      ...(characterIds.length ? { characterIds } : {}),
    },
    { chatIds: [chat.id] },
  ) satisfies LtmScope;
}
