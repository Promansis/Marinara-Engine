import { useMemo, useState } from "react";
import { Check, MessageCircle, Plus, Search, UserRound, X } from "lucide-react";
import type { Chat } from "@marinara-engine/shared";
import { useChats } from "../../hooks/use-chats";
import { useCharacters } from "../../hooks/use-characters";
import { parseCharacterDisplayData } from "../../lib/character-display";
import { cn } from "../../lib/utils";
import { helperTextClassName, insetSectionCardClassName } from "./LtmFields";

export type LtmScopePickerValue = {
  chatIds: string[];
  characterIds: string[];
  groupId?: string;
};

type LtmScopePickerProps = {
  value: LtmScopePickerValue;
  onChange: (next: LtmScopePickerValue) => void;
};

type CharacterRow = {
  id?: unknown;
  data?: unknown;
  comment?: string | null;
};

type PickerKind = "chat" | "character";
export type LtmScopeGroupOption = {
  id: string;
  label: string;
  searchText: string;
};

function uniqueIds(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function chatLabel(chat: Chat | undefined, _id: string) {
  return chat?.name?.trim() || "Unknown Chat";
}

function characterLabel(character: CharacterRow | undefined, _id: string) {
  if (!character) return "Unknown Character";
  const display = parseCharacterDisplayData({ data: character.data, comment: character.comment });
  return display.name.trim() || "Unknown Character";
}

export function LtmScopePicker({ value, onChange }: LtmScopePickerProps) {
  const { data: chats = [] } = useChats();
  const { data: characters = [] } = useCharacters();
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const [query, setQuery] = useState("");

  const chatMap = useMemo(() => new Map((chats as Chat[]).map((chat) => [chat.id, chat])), [chats]);
  const characterMap = useMemo(
    () =>
      new Map(
        (characters as CharacterRow[])
          .filter((character): character is CharacterRow & { id: string } => typeof character.id === "string")
          .map((character) => [character.id, character]),
      ),
    [characters],
  );

  const selectedChatIds = uniqueIds(value.chatIds);
  const selectedCharacterIds = uniqueIds(value.characterIds);
  const selectedGroupId = value.groupId?.trim() || "";
  const normalizedQuery = query.trim().toLowerCase();

  const groupOptions = useMemo(() => {
    const groups = new Map<string, Chat[]>();
    for (const chat of chats as Chat[]) {
      if (!chat.groupId) continue;
      groups.set(chat.groupId, [...(groups.get(chat.groupId) ?? []), chat]);
    }
    return [...groups.entries()]
      .map(([id, groupChats]) => {
        const sorted = [...groupChats].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        const representative = sorted[0];
        const label = representative ? `${representative.name || "Grouped chat"} (${groupChats.length} branch${groupChats.length === 1 ? "" : "es"})` : "Grouped chat";
        return {
          id,
          label,
          searchText: `${label} ${id} ${groupChats.map((chat) => chat.name).join(" ")}`.toLowerCase(),
        } satisfies LtmScopeGroupOption;
      })
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [chats]);

  const selectedGroup = groupOptions.find((group) => group.id === selectedGroupId);

  const filteredChats = useMemo(
    () =>
      (chats as Chat[])
        .filter((chat) => !selectedChatIds.includes(chat.id))
        .filter((chat) => !normalizedQuery || `${chat.name} ${chat.id}`.toLowerCase().includes(normalizedQuery))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 12),
    [chats, normalizedQuery, selectedChatIds],
  );

  const filteredCharacters = useMemo(
    () =>
      (characters as CharacterRow[])
        .filter((character): character is CharacterRow & { id: string } => typeof character.id === "string")
        .filter((character) => !selectedCharacterIds.includes(character.id))
        .filter((character) => {
          const label = characterLabel(character, character.id);
          return !normalizedQuery || `${label} ${character.id}`.toLowerCase().includes(normalizedQuery);
        })
        .sort((left, right) => characterLabel(left, left.id).localeCompare(characterLabel(right, right.id)))
        .slice(0, 12),
    [characters, normalizedQuery, selectedCharacterIds],
  );

  const addId = (kind: PickerKind, id: string) => {
    onChange({
      chatIds: kind === "chat" ? uniqueIds([...selectedChatIds, id]) : selectedChatIds,
      characterIds: kind === "character" ? uniqueIds([...selectedCharacterIds, id]) : selectedCharacterIds,
      groupId: selectedGroupId || undefined,
    });
    setQuery("");
  };

  const removeId = (kind: PickerKind, id: string) => {
    onChange({
      chatIds: kind === "chat" ? selectedChatIds.filter((chatId) => chatId !== id) : selectedChatIds,
      characterIds:
        kind === "character" ? selectedCharacterIds.filter((characterId) => characterId !== id) : selectedCharacterIds,
      groupId: selectedGroupId || undefined,
    });
  };

  const setGroup = (groupId: string) => {
    onChange({
      chatIds: selectedChatIds,
      characterIds: selectedCharacterIds,
      groupId: groupId || undefined,
    });
  };

  const openPicker = (kind: PickerKind) => {
    setPicker((current) => (current === kind ? null : kind));
    setQuery("");
  };

  const options = picker === "chat" ? filteredChats : filteredCharacters;

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-1.5">
        {selectedGroupId && (
          <span
            className={cn(
              "inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--background)] px-2.5 py-1.5 text-[0.6875rem] ring-1 ring-[var(--border)]",
              !selectedGroup && "text-[var(--muted-foreground)]",
            )}
            title={selectedGroupId}
          >
            <MessageCircle size="0.75rem" className="shrink-0 text-[var(--primary)]" />
            <span className="truncate">{selectedGroup?.label ?? "Grouped chat"}</span>
            {!selectedGroup && <span className="text-[0.625rem]">(missing)</span>}
            <button
              type="button"
              onClick={() => setGroup("")}
              className="rounded p-0.5 hover:bg-[var(--secondary)]"
              aria-label={`Remove ${selectedGroupId}`}
            >
              <X size="0.7rem" />
            </button>
          </span>
        )}
        {selectedChatIds.map((id) => {
          const chat = chatMap.get(id);
          return (
            <span
              key={`chat-${id}`}
              className={cn(
                "inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--background)] px-2.5 py-1.5 text-[0.6875rem] ring-1 ring-[var(--border)]",
                !chat && "text-[var(--muted-foreground)]",
              )}
              title={id}
            >
              <MessageCircle size="0.75rem" className="shrink-0 text-[var(--primary)]" />
              <span className="truncate">{chatLabel(chat, id)}</span>
              {!chat && <span className="text-[0.625rem]">(missing)</span>}
              <button
                type="button"
                onClick={() => removeId("chat", id)}
                className="rounded p-0.5 hover:bg-[var(--secondary)]"
                aria-label={`Remove ${id}`}
              >
                <X size="0.7rem" />
              </button>
            </span>
          );
        })}
        {selectedCharacterIds.map((id) => {
          const character = characterMap.get(id);
          return (
            <span
              key={`character-${id}`}
              className={cn(
                "inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--background)] px-2.5 py-1.5 text-[0.6875rem] ring-1 ring-[var(--border)]",
                !character && "text-[var(--muted-foreground)]",
              )}
              title={id}
            >
              <UserRound size="0.75rem" className="shrink-0 text-[var(--primary)]" />
              <span className="truncate">{characterLabel(character, id)}</span>
              {!character && <span className="text-[0.625rem]">(missing)</span>}
              <button
                type="button"
                onClick={() => removeId("character", id)}
                className="rounded p-0.5 hover:bg-[var(--secondary)]"
                aria-label={`Remove ${id}`}
              >
                <X size="0.7rem" />
              </button>
            </span>
          );
        })}
        {!selectedGroupId && !selectedChatIds.length && !selectedCharacterIds.length && (
          <span className={helperTextClassName}>
            Available everywhere unless a chat, group, or character scope is set.
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <label className="min-w-[14rem] max-w-full">
          <span className="mb-1 block text-[0.625rem] font-medium text-[var(--muted-foreground)]">Grouped chat</span>
          <select
            value={selectedGroupId}
            onChange={(event) => setGroup(event.target.value)}
            className="w-full rounded-md bg-[var(--secondary)] py-1.5 pl-2 pr-2 text-xs outline-none ring-1 ring-[var(--border)] focus:ring-2 focus:ring-[var(--primary)]"
          >
            <option value="">No grouped chat scope</option>
            {groupOptions.map((group) => (
              <option key={group.id} value={group.id}>
                {group.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => openPicker("character")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.12em] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]",
            picker === "character" && "bg-[var(--accent)] text-[var(--foreground)]",
          )}
        >
          <Plus size="0.75rem" />
          Add Character
        </button>
        <button
          type="button"
          onClick={() => openPicker("chat")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.12em] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]",
            picker === "chat" && "bg-[var(--accent)] text-[var(--foreground)]",
          )}
        >
          <Plus size="0.75rem" />
          Add Chat
        </button>
      </div>

      {picker && (
        <div className={insetSectionCardClassName}>
          <div className="relative">
            <Search
              size="0.75rem"
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={picker === "chat" ? "Search chats" : "Search characters"}
              className="w-full rounded-md bg-[var(--secondary)] py-1.5 pl-7 pr-2 text-xs outline-none ring-1 ring-[var(--border)] focus:ring-2 focus:ring-[var(--primary)]"
            />
          </div>
          <div className="mt-2 max-h-44 overflow-y-auto">
            {options.length === 0 ? (
              <div className="px-2 py-5 text-center text-[0.6875rem] text-[var(--muted-foreground)]">No matches.</div>
            ) : (
              options.map((option) => {
                const id = option.id;
                const label =
                  picker === "chat" ? chatLabel(option as Chat, id) : characterLabel(option as CharacterRow, id);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => addId(picker, id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--secondary)]"
                  >
                    {picker === "chat" ? <MessageCircle size="0.75rem" /> : <UserRound size="0.75rem" />}
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <Check size="0.75rem" className="text-[var(--muted-foreground)]" />
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
