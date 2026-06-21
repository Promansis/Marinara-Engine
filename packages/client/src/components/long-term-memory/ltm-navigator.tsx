import { useMemo } from "react";
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
    .sort((left, right) => new Date(right.representative.updatedAt).getTime() - new Date(left.representative.updatedAt).getTime());
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
  if (selection.chatId) return threads.find((thread) => thread.chats.some((chat) => chat.id === selection.chatId)) ?? null;
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

export function scopeFromNavigatorSelection(thread: LtmNavigatorThread | null, selection: LtmNavigatorSelection): LtmScope {
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
  onQueryChange,
  onSelect,
}: {
  threads: LtmNavigatorThread[];
  selection: LtmNavigatorSelection;
  activeChatId: string | null;
  scopeLabel: string;
  query: string;
  contextLabel?: string;
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

  return (
    <div className={cn(sectionCardClassName, "space-y-2")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill
          label={followsActive ? "Following active chat" : contextLabel}
          tone={followsActive ? "good" : "warn"}
        />
        <StatusPill label={scopeLabel} />
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 rounded-lg bg-[var(--secondary)] px-2.5 py-2 ring-1 ring-[var(--border)] focus-within:ring-2 focus-within:ring-[var(--ring)]/60">
            <Search size="0.8125rem" className="shrink-0 text-[var(--muted-foreground)]" />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Find chat, branch, ID, or character"
              className="min-w-0 flex-1 bg-transparent text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]/60"
            />
          </div>
          <select
            value={selectedThreadId}
            onChange={(event) => {
              const thread = threads.find((item) => item.id === event.target.value);
              if (thread) onSelect({ groupId: thread.groupId, chatId: thread.groupId ? null : thread.representative.id });
            }}
            className={compactInputClassName}
          >
            {filteredThreads.length === 0 && <option value={selectedThreadId}>No chats match</option>}
            {filteredThreads.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {thread.title} {thread.chats.length > 1 ? `(${thread.chats.length} branches)` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <div className="flex min-h-9 items-center gap-2 rounded-lg bg-[var(--secondary)]/45 px-2.5 text-xs text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
            <GitBranch size="0.8125rem" className="shrink-0" />
            <span className="truncate">Branch</span>
          </div>
          <select
            value={selectedBranchId}
            onChange={(event) => {
              if (!selectedThread) return;
              const chatId = event.target.value || null;
              onSelect({ groupId: selectedThread.groupId, chatId });
            }}
            disabled={!selectedThread || selectedThread.chats.length <= 1}
            className={compactInputClassName}
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
