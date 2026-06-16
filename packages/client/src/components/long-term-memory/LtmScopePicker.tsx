import { useMemo, useState } from "react";
import { Check, MessageCircle, Plus, Search, UserRound, X } from "lucide-react";
import type { Chat } from "@marinara-engine/shared";
import { useChats } from "../../hooks/use-chats";
import { useCharacters } from "../../hooks/use-characters";
import { parseCharacterDisplayData } from "../../lib/character-display";
import { cn } from "../../lib/utils";

export type LtmScopePickerValue = {
  chatIds: string[];
  characterIds: string[];
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
  const normalizedQuery = query.trim().toLowerCase();

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
    });
    setQuery("");
  };

  const removeId = (kind: PickerKind, id: string) => {
    onChange({
      chatIds: kind === "chat" ? selectedChatIds.filter((chatId) => chatId !== id) : selectedChatIds,
      characterIds:
        kind === "character" ? selectedCharacterIds.filter((characterId) => characterId !== id) : selectedCharacterIds,
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
        {selectedChatIds.map((id) => {
          const chat = chatMap.get(id);
          return (
            <span
              key={`chat-${id}`}
              className={cn(
                "inline-flex max-w-full items-center gap-1.5 rounded-md bg-[var(--background)] px-2 py-1 text-[0.6875rem] ring-1 ring-[var(--border)]",
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
                "inline-flex max-w-full items-center gap-1.5 rounded-md bg-[var(--background)] px-2 py-1 text-[0.6875rem] ring-1 ring-[var(--border)]",
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
        {!selectedChatIds.length && !selectedCharacterIds.length && (
          <span className="text-[0.6875rem] text-[var(--muted-foreground)]">
            Available everywhere unless a chat, group, or character scope is set.
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => openPicker("character")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.6875rem] font-medium ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--secondary)]",
            picker === "character" && "bg-[var(--secondary)] text-[var(--foreground)]",
          )}
        >
          <Plus size="0.75rem" />
          Add Character
        </button>
        <button
          type="button"
          onClick={() => openPicker("chat")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.6875rem] font-medium ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--secondary)]",
            picker === "chat" && "bg-[var(--secondary)] text-[var(--foreground)]",
          )}
        >
          <Plus size="0.75rem" />
          Add Chat
        </button>
      </div>

      {picker && (
        <div className="rounded-lg bg-[var(--background)] p-2 ring-1 ring-[var(--border)]">
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
