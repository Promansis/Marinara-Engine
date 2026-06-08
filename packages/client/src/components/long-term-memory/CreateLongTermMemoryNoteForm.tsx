import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, X } from "lucide-react";
import type { Chat, LtmMode, LtmNote, LtmNoteType } from "@marinara-engine/shared";
import { useChat } from "../../hooks/use-chats";
import { useCreateLongTermMemoryNote } from "../../hooks/use-long-term-memory";
import { useChatStore } from "../../stores/chat.store";
import { cn } from "../../lib/utils";
import { FloatingMessageEditor } from "../chat/FloatingMessageEditor";
import { compactInputClassName, SettingField } from "./LtmFields";
import { ToolButton } from "./LtmPills";
import {
  allowedIdPrefixesByType,
  createNoteInput,
  defaultModeFromChatMode,
  defaultSectionKeyForType,
  emptyScopeFromDraft,
  isAllowedNoteId,
  modeOptions,
  normalizeIdentifier,
  normalizeTagsInput,
  noteTypeOptions,
  statusOptions,
} from "./ltm-editor-utils";

type CreateLongTermMemoryNoteFormProps = {
  initialDraft?: CreateLongTermMemoryNoteDraft | null;
  onCancel: () => void;
  onCreated?: (note: LtmNote) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onDraftChange?: (draft: CreateLongTermMemoryNoteDraft) => void;
};

export type CreateLongTermMemoryNoteDraft = {
  type: LtmNoteType;
  id: string;
  status: LtmNote["status"];
  modes: LtmMode[];
  tagsText: string;
  scopeDraft: {
    universe: string;
    rpId: string;
    chatId: string;
    groupId: string;
    characterIdsText: string;
  };
  sectionKey: string;
  sectionText: string;
};

function readLtmScopeMetadata(chat: Chat | null | undefined) {
  const scope = chat?.metadata.longTermMemoryScope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return {};
  return scope as { universe?: string; rpId?: string };
}

function createDefaultDraft({
  activeChat,
  defaultMode,
  metadataScope,
}: {
  activeChat: Chat | null | undefined;
  defaultMode: LtmMode;
  metadataScope: { universe?: string; rpId?: string };
}): CreateLongTermMemoryNoteDraft {
  return {
    type: "scene",
    id: "scene_",
    status: "active",
    modes: [defaultMode],
    tagsText: "",
    scopeDraft: {
      universe: metadataScope.universe ?? "",
      rpId: metadataScope.rpId ?? "",
      chatId: activeChat?.id ?? "",
      groupId: activeChat?.groupId ?? "",
      characterIdsText: activeChat?.characterIds.join(", ") ?? "",
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
  onCancel,
  onCreated,
  onDirtyChange,
  onDraftChange,
}: CreateLongTermMemoryNoteFormProps) {
  const activeChatId = useChatStore((state) => state.activeChatId);
  const cachedActiveChat = useChatStore((state) => state.activeChat);
  const activeChatQuery = useChat(activeChatId);
  const activeChat = activeChatQuery.data ?? cachedActiveChat;
  const createNote = useCreateLongTermMemoryNote();
  const defaultMode = defaultModeFromChatMode(activeChat?.mode);
  const metadataScope = useMemo(() => readLtmScopeMetadata(activeChat), [activeChat]);
  const defaultDraft = useMemo(
    () => createDefaultDraft({ activeChat, defaultMode, metadataScope }),
    [activeChat, defaultMode, metadataScope],
  );
  const [draft, setDraft] = useState<CreateLongTermMemoryNoteDraft>(initialDraft ?? defaultDraft);
  const [summaryEditorOpen, setSummaryEditorOpen] = useState(false);
  const dirty = useMemo(() => serializedCreateDraft(draft) !== serializedCreateDraft(defaultDraft), [defaultDraft, draft]);
  const { type, id, status, modes, tagsText, scopeDraft, sectionKey, sectionText } = draft;

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
          type,
          status,
          modes,
          scope: emptyScopeFromDraft(scopeDraft),
          tags: normalizeTagsInput(tagsText),
          sectionKey,
          sectionText,
        }),
      );
      toast.success("Vault note created");
      onCreated?.(note);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="mb-3 rounded-lg bg-[var(--card)] p-3 ring-1 ring-[var(--primary)]/35">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-[var(--foreground)]">New Vault Note</h3>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
          aria-label="Cancel note creation"
        >
          <X size="0.875rem" />
        </button>
      </div>

      <div className="grid gap-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <SettingField label="Type">
            <select value={type} onChange={(event) => changeType(event.target.value as LtmNoteType)} className={compactInputClassName}>
              {noteTypeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </SettingField>
          <SettingField label="Status">
            <select
              value={status}
              onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as LtmNote["status"] }))}
              className={compactInputClassName}
            >
              {statusOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </SettingField>
        </div>

        <SettingField label={`ID (${prefixes.join(" or ")})`}>
          <input value={id} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} className={compactInputClassName} />
        </SettingField>

        <fieldset className="rounded-lg bg-[var(--secondary)]/35 p-2 ring-1 ring-[var(--border)]">
          <legend className="px-1 text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Modes</legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {modeOptions.map((mode) => (
              <label key={mode} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-[var(--secondary)]">
                <input
                  type="checkbox"
                  checked={modes.includes(mode)}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      modes: event.target.checked ? [...current.modes, mode] : current.modes.filter((item) => item !== mode),
                    }))
                  }
                  className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
                />
                {mode}
              </label>
            ))}
          </div>
        </fieldset>

        <SettingField label="Tags">
          <input value={tagsText} onChange={(event) => setDraft((current) => ({ ...current, tagsText: event.target.value }))} className={compactInputClassName} />
        </SettingField>

        <div className="grid gap-2 rounded-lg bg-[var(--secondary)]/35 p-2 ring-1 ring-[var(--border)]">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Scope</div>
            <button
              type="button"
              onClick={useCurrentChatScope}
              disabled={!activeChat}
              className="rounded-md px-2 py-1 text-[0.6875rem] text-[var(--muted-foreground)] ring-1 ring-[var(--border)] hover:bg-[var(--secondary)] disabled:opacity-50"
            >
              Use Current Chat
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              value={scopeDraft.universe}
              onChange={(event) =>
                setDraft((current) => ({ ...current, scopeDraft: { ...current.scopeDraft, universe: event.target.value } }))
              }
              placeholder="universe"
              className={compactInputClassName}
            />
            <input
              value={scopeDraft.rpId}
              onChange={(event) => setDraft((current) => ({ ...current, scopeDraft: { ...current.scopeDraft, rpId: event.target.value } }))}
              placeholder="rp scope"
              className={compactInputClassName}
            />
            <input
              value={scopeDraft.chatId}
              onChange={(event) => setDraft((current) => ({ ...current, scopeDraft: { ...current.scopeDraft, chatId: event.target.value } }))}
              placeholder="chat id"
              className={compactInputClassName}
            />
            <input
              value={scopeDraft.groupId}
              onChange={(event) => setDraft((current) => ({ ...current, scopeDraft: { ...current.scopeDraft, groupId: event.target.value } }))}
              placeholder="group id"
              className={compactInputClassName}
            />
          </div>
          <input
            value={scopeDraft.characterIdsText}
            onChange={(event) =>
              setDraft((current) => ({ ...current, scopeDraft: { ...current.scopeDraft, characterIdsText: event.target.value } }))
            }
            placeholder="character ids"
            className={compactInputClassName}
          />
        </div>

        <div className="grid gap-2 rounded-lg bg-[var(--secondary)]/35 p-2 ring-1 ring-[var(--border)]">
          <SettingField label="Section key">
            <input
              value={sectionKey}
              onChange={(event) => setDraft((current) => ({ ...current, sectionKey: event.target.value }))}
              className={compactInputClassName}
            />
          </SettingField>
          <button
            type="button"
            onClick={() => setSummaryEditorOpen(true)}
            className="group/summary flex min-h-24 w-full flex-col rounded-lg bg-[var(--background)] px-3 py-2 text-left text-xs text-[var(--foreground)] outline-none ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]/35 focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
          >
            <span className="mb-2 inline-flex items-center gap-1.5 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
              <Pencil size="0.75rem" />
              Edit summary
            </span>
            <span className={cn("line-clamp-4 whitespace-pre-wrap", !sectionText.trim() && "text-[var(--muted-foreground)]/70")}>
              {sectionText.trim() || "No summary text yet."}
            </span>
          </button>
          <FloatingMessageEditor
            open={summaryEditorOpen}
            title="Edit vault summary"
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

        <div className="flex flex-wrap gap-2 border-t border-[var(--border)]/35 pt-3">
          <ToolButton onClick={submit} disabled={createNote.isPending || modes.length === 0} tone="primary">
            {createNote.isPending ? <Loader2 size="0.875rem" className="animate-spin" /> : <Plus size="0.875rem" />}
            Create
          </ToolButton>
          <ToolButton onClick={onCancel} disabled={createNote.isPending}>
            Cancel
          </ToolButton>
        </div>
      </div>
    </div>
  );
}
