import { useId, useMemo } from "react";
import { GitBranch, Search } from "lucide-react";
import type { Chat, LtmScope } from "@marinara-engine/shared";
import { cn } from "../../lib/utils";
import { compactInputClassName, sectionCardClassName } from "./LtmFields";
import { StatusPill } from "./LtmPills";
import type { LtmGroupLookup } from "./ltm-editor-utils";

export type LtmNavigatorSelection = {
  groupId: string | null;
  chatId: string | null;
};

export type LtmNavigatorThread = {
  id: string;
  groupId: string | null;
  title: string;
  chats: Chat[];
  representative: Chat;
  characterIds: string[];
  searchText: string;
};

export type CharacterLookup = Map<string, { name: string }>;

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

export function normalizeChatCharacterIds(value: unknown) {
  if (Array.isArray(value)) return uniqueStrings(value.filter((item): item is string => typeof item === "string"));
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? uniqueStrings(parsed.filter((item): item is string => typeof item === "string"))
      : [];
  } catch {
    return value.trim() ? [value.trim()] : [];
  }
}

export function buildNavigatorThreads(chats: Chat[] | undefined, characters: CharacterLookup): LtmNavigatorThread[] {
  const byThread = new Map<string, Chat[]>();
  for (const chat of chats ?? []) {
    const key = chat.groupId ? `group:${chat.groupId}` : `chat:${chat.id}`;
    byThread.set(key, [...(byThread.get(key) ?? []), chat]);
  }

  return [...byThread.entries()]
    .map(([id, groupChats]) => {
      const sortedChats = [...groupChats].sort((left, right) => {
        const updated = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
        return updated || (right.name || "").localeCompare(left.name || "");
      });
      const representative = sortedChats[0]!;
      const characterIds = uniqueStrings(sortedChats.flatMap((chat) => normalizeChatCharacterIds(chat.characterIds)));
      const characterNames = characterIds.map((characterId) => characters.get(characterId)?.name ?? "").filter(Boolean);
      return {
        id,
        groupId: representative.groupId,
        title: representative.name || "Untitled chat",
        chats: sortedChats,
        representative,
        characterIds,
        searchText: uniqueStrings([
          representative.name,
          representative.id,
          representative.groupId ?? undefined,
          ...sortedChats.flatMap((chat) => [chat.id, chat.name]),
          ...characterNames,
        ])
          .join(" ")
          .toLowerCase(),
      };
    })
    .sort(
      (left, right) =>
        new Date(right.representative.updatedAt).getTime() - new Date(left.representative.updatedAt).getTime(),
    );
}

export function buildNavigatorGroupLookup(threads: LtmNavigatorThread[]): LtmGroupLookup {
  return new Map(
    threads
      .filter((thread) => thread.groupId)
      .map((thread) => [
        thread.groupId!,
        {
          label: `${thread.title}, all branches`,
          rawId: thread.groupId ?? undefined,
        },
      ]),
  );
}

export function findNavigatorThread(threads: LtmNavigatorThread[], selection: LtmNavigatorSelection) {
  if (selection.groupId) return threads.find((thread) => thread.groupId === selection.groupId) ?? null;
  if (selection.chatId)
    return threads.find((thread) => thread.chats.some((chat) => chat.id === selection.chatId)) ?? null;
  return null;
}

export function selectedNavigatorChat(thread: LtmNavigatorThread | null, selection: LtmNavigatorSelection) {
  if (!thread) return null;
  return selection.chatId ? (thread.chats.find((chat) => chat.id === selection.chatId) ?? null) : null;
}

export function navigatorSelectionLabel(thread: LtmNavigatorThread | null, selection: LtmNavigatorSelection) {
  const branch = selectedNavigatorChat(thread, selection);
  if (branch) return branch.name || branch.id;
  if (thread?.groupId) return `${thread.title}, all branches`;
  return thread?.title ?? "No chat selected";
}

export function scopeFromNavigatorSelection(
  thread: LtmNavigatorThread | null,
  selection: LtmNavigatorSelection,
): LtmScope {
  if (!thread) return {};
  const branch = selectedNavigatorChat(thread, selection);
  if (branch) {
    const characterIds = normalizeChatCharacterIds(branch.characterIds);
    return {
      chatId: branch.id,
      chatIds: [branch.id],
      ...(branch.groupId ? { groupId: branch.groupId } : {}),
      ...(characterIds.length ? { characterIds } : {}),
    };
  }
  if (thread.groupId) {
    return {
      groupId: thread.groupId,
      ...(thread.characterIds.length ? { characterIds: thread.characterIds } : {}),
    };
  }
  const chat = thread.representative;
  const characterIds = normalizeChatCharacterIds(chat.characterIds);
  return {
    chatId: chat.id,
    chatIds: [chat.id],
    ...(characterIds.length ? { characterIds } : {}),
  };
}

export function noteFilterFromNavigatorScope(scope: LtmScope) {
  return {
    scopeChatIds: scope.chatIds ?? (scope.chatId ? [scope.chatId] : undefined),
    scopeGroupId: scope.groupId,
    scopeCharacterIds: scope.characterIds,
    includeGlobal: true,
  };
}

export function LtmNavigatorSelector({
  threads,
  selection,
  activeChatId,
  scopeLabel,
  query,
  contextLabel = "Panel scope",
  hideContextPill = false,
  onQueryChange,
  onSelect,
}: {
  threads: LtmNavigatorThread[];
  selection: LtmNavigatorSelection;
  activeChatId: string | null;
  scopeLabel: string;
  query: string;
  contextLabel?: string;
  hideContextPill?: boolean;
  onQueryChange: (query: string) => void;
  onSelect: (selection: LtmNavigatorSelection) => void;
}) {
  const filteredThreads = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return threads;
    return threads.filter((thread) => thread.searchText.includes(needle));
  }, [threads, query]);
  const selectedThread = findNavigatorThread(threads, selection);
  const selectedThreadId = selectedThread?.id ?? "";
  const selectedBranchId = selection.chatId ?? "";
  const followsActive = Boolean(activeChatId && selectedBranchId === activeChatId);
  const fieldId = useId();
  const searchId = `${fieldId}-search`;
  const chatSelectId = `${fieldId}-chat`;
  const branchSelectId = `${fieldId}-branch`;

  return (
    <div className={cn(sectionCardClassName, "space-y-2")}>
      <div className="flex flex-wrap items-center gap-1.5">
        {!hideContextPill && (
          <StatusPill
            label={followsActive ? "Following active chat" : contextLabel}
            tone={followsActive ? "good" : "warn"}
          />
        )}
        <StatusPill label={scopeLabel} />
      </div>
      <div>
        <h4 className="text-sm font-semibold text-[var(--foreground)]">Memory scope</h4>
        <p className="mt-1 text-xs leading-relaxed text-[var(--muted-foreground)]">
          Choose which chat or branch to scope memories to. Global memories are always included.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
        <div className="space-y-1.5">
          <label htmlFor={searchId} className="block text-[0.6875rem] font-semibold text-[var(--muted-foreground)]">
            Search chats
          </label>
          <div className="relative">
            <Search
              size="0.875rem"
              className="mari-chrome-field-icon pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
              aria-hidden="true"
            />
            <input
              id={searchId}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Name, branch, ID, or character"
              className={cn(compactInputClassName, "min-h-10 pl-9")}
            />
          </div>
          <label htmlFor={chatSelectId} className="block text-[0.6875rem] font-semibold text-[var(--muted-foreground)]">
            Chat or grouped chat
          </label>
          <select
            id={chatSelectId}
            value={selectedThreadId}
            onChange={(event) => {
              const thread = threads.find((item) => item.id === event.target.value);
              if (thread)
                onSelect({ groupId: thread.groupId, chatId: thread.groupId ? null : thread.representative.id });
            }}
            className={cn(compactInputClassName, "min-h-10")}
          >
            {threads.length === 0 && <option value="">No chats available</option>}
            {threads.length > 0 && filteredThreads.length === 0 && (
              <option value={selectedThreadId}>No chats match your search</option>
            )}
            {filteredThreads.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {thread.title} {thread.chats.length > 1 ? `(${thread.chats.length} branches)` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor={branchSelectId}
            className="flex min-h-10 items-center gap-2 text-[0.6875rem] font-semibold text-[var(--muted-foreground)] md:items-end md:pb-1.5"
          >
            <GitBranch size="0.875rem" className="shrink-0" aria-hidden="true" />
            Branch
          </label>
          <select
            id={branchSelectId}
            value={selectedBranchId}
            onChange={(event) => {
              if (!selectedThread) return;
              const chatId = event.target.value || null;
              onSelect({ groupId: selectedThread.groupId, chatId });
            }}
            disabled={!selectedThread || selectedThread.chats.length <= 1}
            className={cn(compactInputClassName, "min-h-10")}
          >
            {selectedThread?.groupId && <option value="">All branches</option>}
            {selectedThread?.chats.map((chat) => (
              <option key={chat.id} value={chat.id}>
                {chat.name || "Untitled"} · {chat.id}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
