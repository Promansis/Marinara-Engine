import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronRight, Loader2, Plus } from "lucide-react";
import type { Chat, LtmLink, LtmMode, LtmNote, LtmNoteType } from "@marinara-engine/shared";
import { useChat } from "../../hooks/use-chats";
import { useCreateLongTermMemoryNote } from "../../hooks/use-long-term-memory";
import { useChatStore } from "../../stores/chat.store";
import { cn } from "../../lib/utils";
import {
  compactInputClassName,
  helperTextClassName,
  sectionCardClassName,
  SettingField,
  textareaClassName,
} from "./LtmFields";
import { LtmScopePicker } from "./LtmScopePicker";
import { ToolButton } from "./LtmPills";
import {
  allowedIdPrefixesByType,
  createNoteInput,
  defaultModeFromChatMode,
  defaultSectionKeyForType,
  emptyScopeFromDraft,
  friendlyInternalIdHelp,
  friendlyMode,
  friendlyNoteType,
  friendlySectionKey,
  friendlyStatus,
  groupScopeLabel,
  isAllowedNoteId,
  modeOptions,
  normalizeIdentifier,
  normalizeKeywordsInput,
  normalizeTagsInput,
  noteTypeOptions,
  statusOptions,
  type LtmDisplayLookupContext,
} from "./ltm-editor-utils";

type CreateLongTermMemoryNoteFormProps = {
  initialDraft?: CreateLongTermMemoryNoteDraft | null;
  defaultScopeDraft?: CreateLongTermMemoryNoteDraft["scopeDraft"];
  onCancel: () => void;
  onCreated?: (note: LtmNote) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onDraftChange?: (draft: CreateLongTermMemoryNoteDraft) => void;
  displayContext?: LtmDisplayLookupContext;
  embedded?: boolean;
};

export type CreateLongTermMemoryNoteDraft = {
  type: LtmNoteType;
  id: string;
  title: string;
  status: LtmNote["status"];
  modes: LtmMode[];
  tagsText: string;
  keywordsText: string;
  scopeDraft: {
    chatIds: string[];
    groupId: string;
    characterIds: string[];
  };
  sectionKey: string;
  sectionText: string;
  subjectLabels?: string[];
  tags?: string[];
  keywords?: string[];
  links?: LtmLink[];
  evidence?: string[];
  salience?: number;
  confidence?: number;
};

function readChatCharacterIds(chat: Chat | null | undefined) {
  const raw = chat?.characterIds as unknown;
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    return raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function createDefaultDraft({
  activeChat,
  defaultMode,
  idSuffix,
}: {
  activeChat: Chat | null | undefined;
  defaultMode: LtmMode;
  idSuffix: string;
}): CreateLongTermMemoryNoteDraft {
  return {
    type: "scene",
    id: `scene_memory_${idSuffix}`,
    title: "",
    status: "active",
    modes: [defaultMode],
    tagsText: "",
    keywordsText: "",
    scopeDraft: {
      chatIds: activeChat?.id ? [activeChat.id] : [],
      groupId: activeChat?.groupId ?? "",
      characterIds: readChatCharacterIds(activeChat),
    },
    sectionKey: defaultSectionKeyForType("scene"),
    sectionText: "",
    subjectLabels: [],
  };
}

function generatedNoteId(type: LtmNoteType, title: string, suffix: string) {
  const prefix = allowedIdPrefixesByType[type][0];
  const base = normalizeIdentifier(title, "memory") || "memory";
  return `${prefix}${base}_${suffix}`;
}

function serializedCreateDraft(draft: CreateLongTermMemoryNoteDraft) {
  return JSON.stringify(draft);
}

export function CreateLongTermMemoryNoteForm({
  initialDraft,
  defaultScopeDraft,
  onCancel,
  onCreated,
  onDirtyChange,
  onDraftChange,
  displayContext,
  embedded = false,
}: CreateLongTermMemoryNoteFormProps) {
  const activeChatId = useChatStore((state) => state.activeChatId);
  const cachedActiveChat = useChatStore((state) => state.activeChat);
  const activeChatQuery = useChat(activeChatId);
  const activeChat = activeChatQuery.data ?? cachedActiveChat;
  const createNote = useCreateLongTermMemoryNote();
  const defaultMode = defaultModeFromChatMode(activeChat?.mode);
  const [idSuffix] = useState(() => Math.random().toString(36).slice(2, 7));
  const [autoId, setAutoId] = useState(!initialDraft);
  const [scopeOpen, setScopeOpen] = useState(false);
  const defaultDraft = useMemo(
    () => ({
      ...createDefaultDraft({ activeChat, defaultMode, idSuffix }),
      ...(defaultScopeDraft ? { scopeDraft: defaultScopeDraft } : {}),
    }),
    [activeChat, defaultMode, defaultScopeDraft, idSuffix],
  );
  const [draft, setDraft] = useState<CreateLongTermMemoryNoteDraft>(initialDraft ?? defaultDraft);
  const dirty = useMemo(
    () => serializedCreateDraft(draft) !== serializedCreateDraft(defaultDraft),
    [defaultDraft, draft],
  );
  const { type, id, title, status, modes, tagsText, keywordsText, scopeDraft, sectionKey, sectionText } = draft;

  useEffect(() => {
    if (initialDraft) return;
    setDraft((current) => ({ ...current, modes: [defaultMode] }));
  }, [defaultMode, initialDraft]);

  useEffect(() => {
    if (initialDraft) return;
    setDraft((current) => ({
      ...current,
      scopeDraft: defaultDraft.scopeDraft,
    }));
  }, [defaultDraft.scopeDraft, initialDraft]);

  useEffect(() => {
    if (!autoId) return;
    setDraft((current) => ({ ...current, id: generatedNoteId(current.type, current.title, idSuffix) }));
  }, [autoId, idSuffix, title, type]);

  useEffect(() => {
    onDirtyChange?.(dirty);
    onDraftChange?.(draft);
  }, [dirty, draft, onDirtyChange, onDraftChange]);

  const prefixes = allowedIdPrefixesByType[type];

  const changeType = (nextType: LtmNoteType) => {
    setDraft((current) => ({
      ...current,
      type: nextType,
      sectionKey: defaultSectionKeyForType(nextType),
      subjectLabels: nextType === "character" ? [""] : nextType === "relationship" ? ["", ""] : [],
    }));
  };

  const useCurrentChatScope = () => {
    setDraft((current) => ({
      ...current,
      modes: [defaultModeFromChatMode(activeChat?.mode)],
      scopeDraft: defaultDraft.scopeDraft,
    }));
  };

  const submit = async () => {
    const normalizedId = normalizeIdentifier(id, prefixes[0].replace(/_$/, ""));
    if (!isAllowedNoteId(type, normalizedId)) {
      toast.error(`ID for ${type} notes must start with ${prefixes.join(" or ")}`);
      return;
    }
    if (!sectionText.trim()) {
      toast.error("Add section text before creating the note");
      return;
    }
    const subjectLabels = (draft.subjectLabels ?? []).map((label) => label.trim()).filter(Boolean);
    const expectedSubjectCount = type === "character" ? 1 : type === "relationship" ? 2 : 0;
    if (expectedSubjectCount > 0 && subjectLabels.length !== expectedSubjectCount) {
      toast.error(
        `${type === "character" ? "Character" : "Relationship"} memories require ${expectedSubjectCount === 1 ? "a subject" : "two participants"}`,
      );
      return;
    }
    const subjectKeys = subjectLabels.map((label) => `manual:${normalizeIdentifier(label, "subject")}`);
    if (new Set(subjectKeys).size !== subjectKeys.length) {
      toast.error("Relationship participants must be distinct");
      return;
    }
    try {
      const note = await createNote.mutateAsync(
        createNoteInput({
          id: normalizedId,
          title,
          type,
          status,
          modes,
          scope: emptyScopeFromDraft(scopeDraft),
          tags: draft.tags ?? normalizeTagsInput(tagsText),
          keywords: draft.keywords ?? normalizeKeywordsInput(keywordsText),
          sectionKey,
          sectionText,
          links: draft.links,
          evidence: draft.evidence,
          salience: draft.salience,
          confidence: draft.confidence,
          subjects: subjectKeys.length
            ? subjectKeys.map((key) => ({ key })).sort((left, right) => left.key.localeCompare(right.key))
            : undefined,
        }),
      );
      toast.success("Memory created");
      onCreated?.(note);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-4">
        <SettingField label="Title">
          <input
            value={title}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            placeholder="Poppy chapel promise"
            className={compactInputClassName}
          />
        </SettingField>

        <SettingField label="Memory Text">
          <textarea
            value={sectionText}
            onChange={(event) => setDraft((current) => ({ ...current, sectionText: event.target.value }))}
            placeholder="What should Marinara remember?"
            className={cn(textareaClassName, "min-h-36")}
          />
        </SettingField>

        <SettingField label="Type">
          <select
            value={type}
            onChange={(event) => changeType(event.target.value as LtmNoteType)}
            className={compactInputClassName}
          >
            {noteTypeOptions.map((option) => (
              <option key={option} value={option}>
                {friendlyNoteType(option)}
              </option>
            ))}
          </select>
        </SettingField>

        {type === "character" ? (
          <SettingField label="Character subject">
            <input
              value={draft.subjectLabels?.[0] ?? ""}
              onChange={(event) => setDraft((current) => ({ ...current, subjectLabels: [event.target.value] }))}
              placeholder="Damo Korvak"
              className={compactInputClassName}
            />
          </SettingField>
        ) : type === "relationship" ? (
          <fieldset className={sectionCardClassName}>
            <legend className="px-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
              Participants
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {[0, 1].map((index) => (
                <input
                  key={index}
                  value={draft.subjectLabels?.[index] ?? ""}
                  onChange={(event) =>
                    setDraft((current) => {
                      const next = [...(current.subjectLabels ?? [])];
                      next[index] = event.target.value;
                      return { ...current, subjectLabels: next };
                    })
                  }
                  aria-label={`Participant ${index + 1}`}
                  placeholder={index === 0 ? "Damo Korvak" : "Lisa Imai"}
                  className={compactInputClassName}
                />
              ))}
            </div>
          </fieldset>
        ) : null}

        <div className={sectionCardClassName}>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                Scope
              </div>
              <p className={cn("mt-1 truncate", helperTextClassName)}>
                {scopeDraft.chatIds.length > 0 || scopeDraft.groupId || scopeDraft.characterIds.length > 0
                  ? `${scopeDraft.chatIds.length} chat link${scopeDraft.chatIds.length === 1 ? "" : "s"}, ${scopeDraft.characterIds.length} character link${scopeDraft.characterIds.length === 1 ? "" : "s"}${scopeDraft.groupId ? ", grouped chat" : ""}`
                  : "Available everywhere"}
              </p>
            </div>
            <ToolButton onClick={() => setScopeOpen((current) => !current)}>
              {scopeOpen ? "Done" : "Change scope"}
            </ToolButton>
          </div>
          {scopeOpen && (
            <div className="mt-3 border-t border-[var(--border)] pt-3">
              <div className="mb-2 flex justify-end">
                <ToolButton onClick={useCurrentChatScope} disabled={!activeChat}>
                  Use this chat
                </ToolButton>
              </div>
              <LtmScopePicker
                value={{
                  chatIds: scopeDraft.chatIds,
                  characterIds: scopeDraft.characterIds,
                  groupId: scopeDraft.groupId || undefined,
                }}
                onChange={(next) =>
                  setDraft((current) => ({
                    ...current,
                    scopeDraft: {
                      ...current.scopeDraft,
                      chatIds: next.chatIds,
                      characterIds: next.characterIds,
                      groupId: next.groupId ?? "",
                    },
                  }))
                }
              />
              {scopeDraft.groupId ? (
                <div className="text-[0.6875rem] text-[var(--muted-foreground)]">
                  Grouped chat: {groupScopeLabel(scopeDraft.groupId, displayContext) ?? "Grouped chat"}
                </div>
              ) : null}
            </div>
          )}
        </div>

        <details className={cn(sectionCardClassName, "group")}>
          <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 text-xs font-semibold text-[var(--foreground)]">
            <ChevronRight size="0.875rem" className="text-[var(--primary)] transition-transform group-open:rotate-90" />
            Advanced options
          </summary>
          <div className="mt-3 grid gap-4 border-t border-[var(--border)] pt-3">
            <SettingField label="Status">
              <select
                value={status}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, status: event.target.value as LtmNote["status"] }))
                }
                className={compactInputClassName}
              >
                {statusOptions.map((option) => (
                  <option key={option} value={option}>
                    {friendlyStatus(option)}
                  </option>
                ))}
              </select>
            </SettingField>
            <fieldset>
              <legend className="mb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                Use In
              </legend>
              <div className="grid gap-1 sm:grid-cols-3">
                {modeOptions.map((mode) => (
                  <label
                    key={mode}
                    className="flex min-h-10 items-center gap-2 rounded-lg px-2.5 text-xs hover:bg-[var(--accent)]/60"
                  >
                    <input
                      type="checkbox"
                      checked={modes.includes(mode)}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          modes: event.target.checked
                            ? [...current.modes, mode]
                            : current.modes.filter((item) => item !== mode),
                        }))
                      }
                      className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
                    />
                    {friendlyMode(mode)}
                  </label>
                ))}
              </div>
            </fieldset>
            <SettingField label="Keywords">
              <textarea
                value={keywordsText}
                onChange={(event) => setDraft((current) => ({ ...current, keywordsText: event.target.value }))}
                rows={2}
                className={cn(textareaClassName, "min-h-20")}
                placeholder="captain, silver pact, midnight market"
              />
            </SettingField>
            <SettingField label="Tags">
              <input
                value={tagsText}
                onChange={(event) => setDraft((current) => ({ ...current, tagsText: event.target.value }))}
                className={compactInputClassName}
              />
            </SettingField>
            <SettingField label="Section key">
              <input
                value={sectionKey}
                onChange={(event) => setDraft((current) => ({ ...current, sectionKey: event.target.value }))}
                placeholder={friendlySectionKey(sectionKey)}
                className={compactInputClassName}
              />
            </SettingField>
            <SettingField label="Internal ID">
              <input
                value={id}
                onChange={(event) => {
                  setAutoId(false);
                  setDraft((current) => ({ ...current, id: event.target.value }));
                }}
                className={compactInputClassName}
              />
              <p className={helperTextClassName}>
                {autoId ? "Generated from the type and title." : friendlyInternalIdHelp(prefixes)}
              </p>
            </SettingField>
          </div>
        </details>

        <div
          className={cn(
            "sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[var(--background)]/95 py-3 backdrop-blur-sm",
            embedded ? "-mx-3 px-3" : "-mx-5 px-5",
          )}
        >
          <ToolButton onClick={submit} disabled={createNote.isPending || modes.length === 0} tone="primary">
            {createNote.isPending ? <Loader2 size="0.875rem" className="animate-spin" /> : <Plus size="0.875rem" />}
            Save Memory
          </ToolButton>
          <ToolButton onClick={onCancel} disabled={createNote.isPending}>
            {embedded ? "Back" : "Cancel"}
          </ToolButton>
        </div>
      </div>
    </div>
  );
}
