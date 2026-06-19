import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Plus } from "lucide-react";
import type { Chat, LtmLink, LtmMode, LtmNote, LtmNoteType } from "@marinara-engine/shared";
import { useChat } from "../../hooks/use-chats";
import { useCreateLongTermMemoryNote } from "../../hooks/use-long-term-memory";
import { useChatStore } from "../../stores/chat.store";
import { cn } from "../../lib/utils";
import { FloatingMessageEditor } from "../chat/FloatingMessageEditor";
import {
  actionRowClassName,
  compactInputClassName,
  helperTextClassName,
  modalIntroCardClassName,
  sectionCardClassName,
  SettingField,
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
};

export type CreateLongTermMemoryNoteDraft = {
  type: LtmNoteType;
  id: string;
  title: string;
  status: LtmNote["status"];
  modes: LtmMode[];
  tagsText: string;
  scopeDraft: {
    chatIds: string[];
    groupId: string;
    characterIds: string[];
  };
  sectionKey: string;
  sectionText: string;
  tags?: string[];
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
}: {
  activeChat: Chat | null | undefined;
  defaultMode: LtmMode;
}): CreateLongTermMemoryNoteDraft {
  return {
    type: "scene",
    id: "scene_",
    title: "",
    status: "active",
    modes: [defaultMode],
    tagsText: "",
    scopeDraft: {
      chatIds: activeChat?.id ? [activeChat.id] : [],
      groupId: activeChat?.groupId ?? "",
      characterIds: readChatCharacterIds(activeChat),
    },
    sectionKey: defaultSectionKeyForType("scene"),
    sectionText: "",
  };
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
}: CreateLongTermMemoryNoteFormProps) {
  const activeChatId = useChatStore((state) => state.activeChatId);
  const cachedActiveChat = useChatStore((state) => state.activeChat);
  const activeChatQuery = useChat(activeChatId);
  const activeChat = activeChatQuery.data ?? cachedActiveChat;
  const createNote = useCreateLongTermMemoryNote();
  const defaultMode = defaultModeFromChatMode(activeChat?.mode);
  const defaultDraft = useMemo(
    () => ({
      ...createDefaultDraft({ activeChat, defaultMode }),
      ...(defaultScopeDraft ? { scopeDraft: defaultScopeDraft } : {}),
    }),
    [activeChat, defaultMode, defaultScopeDraft],
  );
  const [draft, setDraft] = useState<CreateLongTermMemoryNoteDraft>(initialDraft ?? defaultDraft);
  const [summaryEditorOpen, setSummaryEditorOpen] = useState(false);
  const dirty = useMemo(
    () => serializedCreateDraft(draft) !== serializedCreateDraft(defaultDraft),
    [defaultDraft, draft],
  );
  const { type, id, title, status, modes, tagsText, scopeDraft, sectionKey, sectionText } = draft;

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
    onDirtyChange?.(dirty);
    onDraftChange?.(draft);
  }, [dirty, draft, onDirtyChange, onDraftChange]);

  const prefixes = allowedIdPrefixesByType[type];

  const changeType = (nextType: LtmNoteType) => {
    setDraft((current) => ({
      ...current,
      type: nextType,
      id: allowedIdPrefixesByType[nextType][0],
      sectionKey: defaultSectionKeyForType(nextType),
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
          sectionKey,
          sectionText,
          links: draft.links,
          evidence: draft.evidence,
          salience: draft.salience,
          confidence: draft.confidence,
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
      <div className={modalIntroCardClassName}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-[var(--foreground)]">Add a manual memory</span>
          <span className="rounded-full border border-[var(--border)] bg-[var(--muted)]/55 px-2 py-1 text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
            Saved to the current vault
          </span>
        </div>
        <p className={cn("mt-2", helperTextClassName)}>
          Create a typed memory with the same scope, tags, and section structure used across the rest of Marinara.
        </p>
      </div>

      <div className="grid gap-4">
        <div className="grid gap-2 sm:grid-cols-2">
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
        </div>

        <SettingField label="Title">
          <input
            value={title}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            placeholder="Poppy chapel promise"
            className={compactInputClassName}
          />
        </SettingField>

        <SettingField label="Internal ID">
          <div className="space-y-1">
            <input
              value={id}
              onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))}
              placeholder="poppy_chapel_promise"
              className={compactInputClassName}
            />
            <p className="text-[0.625rem] text-[var(--muted-foreground)]">{friendlyInternalIdHelp(prefixes)}</p>
          </div>
        </SettingField>

        <fieldset className={sectionCardClassName}>
          <legend className="px-1 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
            Use In
          </legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {modeOptions.map((mode) => (
              <label
                key={mode}
                className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs transition-colors hover:bg-[var(--accent)]/60"
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

        <SettingField label="Tags">
          <input
            value={tagsText}
            onChange={(event) => setDraft((current) => ({ ...current, tagsText: event.target.value }))}
            className={compactInputClassName}
          />
        </SettingField>

        <div className={sectionCardClassName}>
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                Where this applies
              </div>
              <p className={cn("mt-1", helperTextClassName)}>
                Limit this memory to specific chats, groups, or linked characters when needed.
              </p>
            </div>
            <button
              type="button"
              onClick={useCurrentChatScope}
              disabled={!activeChat}
              className="rounded-lg px-2.5 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-50"
            >
              Use this chat
            </button>
          </div>
          <LtmScopePicker
            value={{ chatIds: scopeDraft.chatIds, characterIds: scopeDraft.characterIds, groupId: scopeDraft.groupId || undefined }}
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
            <div className="text-[0.625rem] text-[var(--muted-foreground)]">
              Grouped chat: {groupScopeLabel(scopeDraft.groupId, displayContext) ?? "Grouped chat"}
            </div>
          ) : null}
        </div>

        <div className={sectionCardClassName}>
          <SettingField label="Detail label">
            <input
              value={sectionKey}
              onChange={(event) => setDraft((current) => ({ ...current, sectionKey: event.target.value }))}
            placeholder={friendlySectionKey(sectionKey)}
            className={compactInputClassName}
          />
          </SettingField>
          <p className={helperTextClassName}>Start with the clearest single section for this memory. You can expand it later.</p>
          <button
            type="button"
            onClick={() => setSummaryEditorOpen(true)}
            className="group/summary flex min-h-28 w-full flex-col rounded-xl bg-[var(--background)] px-3 py-3 text-left text-xs text-[var(--foreground)] outline-none ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]/45 focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60"
          >
            <span className="mb-2 inline-flex items-center gap-1.5 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
              <Pencil size="0.75rem" />
              Edit memory text
            </span>
            <span
              className={cn(
                "line-clamp-4 whitespace-pre-wrap",
                !sectionText.trim() && "text-[var(--muted-foreground)]/70",
              )}
            >
              {sectionText.trim() || "No memory text yet."}
            </span>
          </button>
          <FloatingMessageEditor
            open={summaryEditorOpen}
            title="Edit memory text"
            initialContent={sectionText}
            fontSize={13}
            showFormatting
            onSave={(content) => {
              setDraft((current) => ({ ...current, sectionText: content }));
              setSummaryEditorOpen(false);
            }}
            onCancel={() => setSummaryEditorOpen(false)}
          />
        </div>

        <div className={actionRowClassName}>
          <ToolButton onClick={submit} disabled={createNote.isPending || modes.length === 0} tone="primary">
            {createNote.isPending ? <Loader2 size="0.875rem" className="animate-spin" /> : <Plus size="0.875rem" />}
            Save Memory
          </ToolButton>
          <ToolButton onClick={onCancel} disabled={createNote.isPending}>
            Cancel
          </ToolButton>
        </div>
      </div>
    </div>
  );
}
