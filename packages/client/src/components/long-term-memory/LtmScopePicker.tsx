import { useId, useMemo, useState } from "react";
import { Check, MessageCircle, Plus, Search, UserRound, X } from "lucide-react";
import type { Chat } from "@marinara-engine/shared";
import { useChats } from "../../hooks/use-chats";
import { useCharacters } from "../../hooks/use-characters";
import { parseCharacterDisplayData } from "../../lib/character-display";
import { cn } from "../../lib/utils";
import { compactInputClassName, helperTextClassName, insetSectionCardClassName } from "./LtmFields";

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
  const pickerId = useId();
  const groupSelectId = `${pickerId}-group`;
  const pickerPanelId = `${pickerId}-options`;
  const pickerSearchId = `${pickerId}-search`;

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
        const label = representative
          ? `${representative.name || "Grouped chat"} (${groupChats.length} branch${groupChats.length === 1 ? "" : "es"})`
          : "Grouped chat";
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
      <div className="flex flex-wrap gap-2">
        {selectedGroupId && (
          <span
            className={cn(
              "inline-flex max-w-full items-stretch gap-1 rounded-lg border border-[var(--border)] bg-[var(--background)] pl-2.5 text-xs",
              !selectedGroup && "text-[var(--muted-foreground)]",
            )}
          >
            <MessageCircle size="0.75rem" className="self-center text-[var(--primary)]" aria-hidden="true" />
            <span className="min-w-0 self-center break-words py-2 md:py-1.5">
              {selectedGroup?.label ?? "Grouped chat"}
              {!selectedGroup && <span className="ml-1 text-[var(--muted-foreground)]">(missing)</span>}
            </span>
            <button
              type="button"
              onClick={() => setGroup("")}
              className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] active:scale-95 md:min-h-7 md:min-w-7"
              aria-label={`Remove grouped chat scope ${selectedGroup?.label ?? selectedGroupId}`}
            >
              <X size="0.875rem" aria-hidden="true" />
            </button>
          </span>
        )}
        {selectedChatIds.map((id) => {
          const chat = chatMap.get(id);
          return (
            <span
              key={`chat-${id}`}
              className={cn(
                "inline-flex max-w-full items-stretch gap-1 rounded-lg border border-[var(--border)] bg-[var(--background)] pl-2.5 text-xs",
                !chat && "text-[var(--muted-foreground)]",
              )}
            >
              <MessageCircle size="0.75rem" className="self-center text-[var(--primary)]" aria-hidden="true" />
              <span className="min-w-0 self-center break-words py-2 md:py-1.5">
                {chatLabel(chat, id)}
                {!chat && <span className="ml-1 text-[var(--muted-foreground)]">(missing)</span>}
              </span>
              <button
                type="button"
                onClick={() => removeId("chat", id)}
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] active:scale-95 md:min-h-7 md:min-w-7"
                aria-label={`Remove chat scope ${chatLabel(chat, id)}`}
              >
                <X size="0.875rem" aria-hidden="true" />
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
                "inline-flex max-w-full items-stretch gap-1 rounded-lg border border-[var(--border)] bg-[var(--background)] pl-2.5 text-xs",
                !character && "text-[var(--muted-foreground)]",
              )}
            >
              <UserRound size="0.75rem" className="self-center text-[var(--primary)]" aria-hidden="true" />
              <span className="min-w-0 self-center break-words py-2 md:py-1.5">
                {characterLabel(character, id)}
                {!character && <span className="ml-1 text-[var(--muted-foreground)]">(missing)</span>}
              </span>
              <button
                type="button"
                onClick={() => removeId("character", id)}
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] active:scale-95 md:min-h-7 md:min-w-7"
                aria-label={`Remove character scope ${characterLabel(character, id)}`}
              >
                <X size="0.875rem" aria-hidden="true" />
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

      <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(14rem,1fr)_auto_auto]">
        <label htmlFor={groupSelectId} className="min-w-0">
          <span className="mb-1.5 block text-[0.6875rem] font-semibold text-[var(--muted-foreground)]">
            Grouped chat
          </span>
          <select
            id={groupSelectId}
            value={selectedGroupId}
            onChange={(event) => setGroup(event.target.value)}
            className={cn(compactInputClassName, "min-h-10")}
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
          aria-expanded={picker === "character"}
          aria-controls={pickerPanelId}
          className={cn(
            "inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-xs font-semibold text-[var(--foreground)] transition-colors hover:border-[var(--ring)]/40 hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] active:scale-[0.98] sm:min-h-10 sm:w-auto",
            picker === "character" && "bg-[var(--accent)] text-[var(--foreground)]",
          )}
        >
          <Plus size="0.875rem" aria-hidden="true" />
          Add character
        </button>
        <button
          type="button"
          onClick={() => openPicker("chat")}
          aria-expanded={picker === "chat"}
          aria-controls={pickerPanelId}
          className={cn(
            "inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-xs font-semibold text-[var(--foreground)] transition-colors hover:border-[var(--ring)]/40 hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] active:scale-[0.98] sm:min-h-10 sm:w-auto",
            picker === "chat" && "bg-[var(--accent)] text-[var(--foreground)]",
          )}
        >
          <Plus size="0.875rem" aria-hidden="true" />
          Add chat
        </button>
      </div>

      {picker && (
        <div id={pickerPanelId} className={insetSectionCardClassName}>
          <label
            htmlFor={pickerSearchId}
            className="mb-1.5 block text-[0.6875rem] font-semibold text-[var(--muted-foreground)]"
          >
            {picker === "chat" ? "Search chats" : "Search characters"}
          </label>
          <div className="relative">
            <Search
              size="0.875rem"
              className="mari-chrome-field-icon pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
              aria-hidden="true"
            />
            <input
              id={pickerSearchId}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={picker === "chat" ? "Name or chat ID" : "Name or character ID"}
              className={cn(compactInputClassName, "min-h-10 pl-9")}
            />
          </div>
          <div className="mt-2 max-h-52 overflow-y-auto" aria-live="polite">
            {options.length === 0 ? (
              <div className="px-2 py-5 text-center text-xs text-[var(--muted-foreground)]">No matches found.</div>
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
                    className="flex min-h-11 w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] active:scale-[0.99] md:min-h-10"
                  >
                    {picker === "chat" ? (
                      <MessageCircle size="0.875rem" className="mt-0.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <UserRound size="0.875rem" className="mt-0.5 shrink-0" aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1 break-words">{label}</span>
                    <Check
                      size="0.875rem"
                      className="mt-0.5 shrink-0 text-[var(--muted-foreground)]"
                      aria-hidden="true"
                    />
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
