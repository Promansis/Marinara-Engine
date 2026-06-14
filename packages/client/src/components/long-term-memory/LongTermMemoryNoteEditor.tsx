import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Archive, Loader2, Pencil, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import {
  getLtmScopeChatIds,
  withMergedLtmScopeLinks,
  type LtmLink,
  type LtmMode,
  type LtmNote,
  type LtmSection,
} from "@marinara-engine/shared";
import {
  useApplyLongTermMemoryScopeToDerived,
  useArchiveLongTermMemoryNote,
  useRebuildLongTermMemory,
  useUpdateLongTermMemoryNote,
} from "../../hooks/use-long-term-memory";
import { useChat } from "../../hooks/use-chats";
import { cn } from "../../lib/utils";
import { useChatStore } from "../../stores/chat.store";
import { FloatingMessageEditor } from "../chat/FloatingMessageEditor";
import { compactInputClassName, SettingField, textareaClassName } from "./LtmFields";
import { LtmScopePicker } from "./LtmScopePicker";
import { LongTermMemorySuggestionsTab } from "./LongTermMemorySuggestionsTab";
import { ToolButton } from "./LtmPills";
import {
  editablePatchFromDraft,
  emptySection,
  friendlyIdentifier,
  friendlyMode,
  friendlyNoteTitle,
  friendlySectionKey,
  friendlyStatus,
  modeOptions,
  normalizeIdentifier,
  normalizeTagsInput,
  statusOptions,
} from "./ltm-editor-utils";

type LongTermMemoryNoteEditorProps = {
  note: LtmNote;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: (note: LtmNote) => void;
};

function serializedEditable(note: LtmNote) {
  return JSON.stringify(editablePatchFromDraft(note));
}

function numberOrUndefined(value: string) {
  if (!value.trim()) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : undefined;
}

function sectionHasContent(section: LtmSection) {
  return section.text.trim().length > 0;
}

function readChatCharacterIds(value: unknown) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function isSourceMemory(note: LtmNote) {
  return (
    note.type === "source" ||
    (note.type === "scene" && note.tags.some((tag) => tag === "source_summary" || tag === "chat_summary"))
  );
}

export function LongTermMemoryNoteEditor({ note, onCancel, onDirtyChange, onSaved }: LongTermMemoryNoteEditorProps) {
  const activeChatId = useChatStore((state) => state.activeChatId);
  const cachedActiveChat = useChatStore((state) => state.activeChat);
  const activeChatQuery = useChat(activeChatId);
  const activeChat = activeChatQuery.data ?? cachedActiveChat;
  const [savedBaseline, setSavedBaseline] = useState(note);
  const [draft, setDraft] = useState(note);
  const [tagsText, setTagsText] = useState(note.tags.join(", "));
  const [linkDraft, setLinkDraft] = useState<LtmLink>({ target: "", relation: "" });
  const [floatingSectionKey, setFloatingSectionKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"details" | "suggestions">("details");
  const updateNote = useUpdateLongTermMemoryNote();
  const archiveNote = useArchiveLongTermMemoryNote();
  const applyScopeToDerived = useApplyLongTermMemoryScopeToDerived();
  const rebuild = useRebuildLongTermMemory();

  useEffect(() => {
    setSavedBaseline(note);
    setDraft(note);
    setTagsText(note.tags.join(", "));
  }, [note]);

  const dirty = useMemo(() => serializedEditable(draft) !== serializedEditable(savedBaseline), [draft, savedBaseline]);
  const busy = updateNote.isPending || archiveNote.isPending || rebuild.isPending || applyScopeToDerived.isPending;
  const sourceMemory = isSourceMemory(draft);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const setSection = (key: string, updater: (section: LtmSection) => LtmSection) => {
    setDraft((current) => ({
      ...current,
      sections: {
        ...current.sections,
        [key]: {
          ...updater(current.sections[key]),
          updatedAt: new Date().toISOString(),
        },
      },
    }));
  };

  const validateDraft = () => {
    const entries = Object.entries(draft.sections);
    if (entries.length === 0) return "At least one section is required.";
    const empty = entries.find(([, section]) => !sectionHasContent(section));
    if (empty) return `Section ${empty[0]} needs text.`;
    if (draft.modes.length === 0) return "Select at least one mode.";
    return null;
  };

  const save = async ({ rebuildAfter = false }: { rebuildAfter?: boolean } = {}) => {
    const error = validateDraft();
    if (error) {
      toast.error(error);
      return;
    }
    try {
      const saved = await updateNote.mutateAsync({ id: draft.id, patch: editablePatchFromDraft(draft) });
      toast.success("Memory saved");
      setSavedBaseline(saved);
      setDraft(saved);
      onDirtyChange?.(false);
      onSaved?.(saved);
      if (rebuildAfter) {
        try {
          await rebuild.mutateAsync();
          toast.success("Memory search refreshed");
        } catch (err) {
          toast.error(`Saved, but rebuild failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const cancel = () => {
    if (dirty && !confirm("Discard unsaved memory changes?")) return;
    onCancel();
  };

  const archive = async () => {
    if (!confirm(`Archive ${friendlyNoteTitle(draft)}?`)) return;
    try {
      const result = await archiveNote.mutateAsync(draft.id);
      toast.success("Memory archived");
      setSavedBaseline(result.note);
      setDraft(result.note);
      onDirtyChange?.(false);
      onSaved?.(result.note);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const renameSection = (from: string, nextRaw: string) => {
    const to = normalizeIdentifier(nextRaw, "section");
    if (!to || to === from) return;
    if (draft.sections[to]) {
      toast.error(`Section ${to} already exists`);
      return;
    }
    setDraft((current) => {
      const { [from]: section, ...rest } = current.sections;
      return {
        ...current,
        sections: {
          ...rest,
          [to]: section,
        },
      };
    });
  };

  const addSection = () => {
    setDraft((current) => {
      let index = Object.keys(current.sections).length + 1;
      let key = `section_${index}`;
      while (current.sections[key]) {
        index += 1;
        key = `section_${index}`;
      }
      return {
        ...current,
        sections: {
          ...current.sections,
          [key]: emptySection(),
        },
      };
    });
  };

  const removeSection = (key: string) => {
    if (Object.keys(draft.sections).length <= 1) {
      toast.error("At least one section is required");
      return;
    }
    setDraft((current) => {
      const { [key]: _removed, ...sections } = current.sections;
      return { ...current, sections };
    });
  };

  const addLink = () => {
    const target = normalizeIdentifier(linkDraft.target, "note");
    const relation = normalizeIdentifier(linkDraft.relation, "relation");
    if (!target || !relation) return;
    setDraft((current) => ({ ...current, links: [...current.links, { target, relation }] }));
    setLinkDraft({ target: "", relation: "" });
  };

  const setLinkedScope = (next: { chatIds: string[]; characterIds: string[] }) => {
    setDraft((current) => {
      const { chatId: _chatId, chatIds: _chatIds, characterIds: _characterIds, ...restScope } = current.scope;
      return { ...current, scope: withMergedLtmScopeLinks(restScope, next) };
    });
  };

  const useCurrentChatScope = () => {
    if (!activeChat) return;
    setDraft((current) => {
      const { chatId: _chatId, chatIds: _chatIds, characterIds: _characterIds, ...restScope } = current.scope;
      return {
        ...current,
        scope: withMergedLtmScopeLinks(
          {
            ...restScope,
            groupId: activeChat.groupId ?? undefined,
          },
          { chatIds: [activeChat.id], characterIds: readChatCharacterIds(activeChat.characterIds) },
        ),
      };
    });
  };

  const applyToDerived = async () => {
    const chatIds = getLtmScopeChatIds(draft.scope);
    const characterIds = draft.scope.characterIds ?? [];
    if (!chatIds.length && !characterIds.length) {
      toast.error("Add chat or character links first");
      return;
    }
    try {
      const result = await applyScopeToDerived.mutateAsync({ noteId: draft.id, chatIds, characterIds });
      toast.success(
        result.count === 1
          ? "Applied links to 1 extracted memory"
          : `Applied links to ${result.count} extracted memories`,
      );
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const floatingSection = floatingSectionKey ? draft.sections[floatingSectionKey] : null;

  return (
    <div className="grid gap-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[0.625rem] text-[var(--muted-foreground)]">
            {friendlyStatus(draft.status)} · version {draft.version} · updated{" "}
            {new Date(draft.updatedAt).toLocaleString()}
          </div>
        </div>
        {dirty && (
          <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[0.625rem] text-amber-200">Unsaved</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-1 rounded-xl bg-[var(--background)]/95 p-1">
        {(["details", "suggestions"] as const).map((tab) => {
          const disabled = tab === "suggestions" && !sourceMemory;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => !disabled && setActiveTab(tab)}
              disabled={disabled}
              className={cn(
                "rounded-lg px-2 py-1.5 text-xs font-medium transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45",
                activeTab === tab
                  ? "bg-rose-300/15 text-[var(--foreground)] ring-1 ring-rose-300/30"
                  : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
              )}
            >
              {tab === "details" ? "Details" : "Suggestions"}
            </button>
          );
        })}
      </div>

      {activeTab === "suggestions" && <LongTermMemorySuggestionsTab note={savedBaseline} />}

      {activeTab === "details" && (
      <div className="grid gap-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <SettingField label="Status">
            <select
              value={draft.status}
              onChange={(event) =>
                setDraft((current) => ({ ...current, status: event.target.value as LtmNote["status"] }))
              }
              className={compactInputClassName}
            >
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {friendlyStatus(status)}
                </option>
              ))}
            </select>
          </SettingField>
          <SettingField label="Tags">
            <input
              value={tagsText}
              onChange={(event) => setTagsText(event.target.value)}
              onBlur={() => setDraft((current) => ({ ...current, tags: normalizeTagsInput(tagsText) }))}
              className={compactInputClassName}
            />
          </SettingField>
        </div>

        <fieldset className="rounded-lg bg-[var(--secondary)]/35 p-2 ring-1 ring-[var(--border)]">
          <legend className="px-1 text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Use In</legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {modeOptions.map((mode) => (
              <label
                key={mode}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-[var(--secondary)]"
              >
                <input
                  type="checkbox"
                  checked={draft.modes.includes(mode)}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      modes: event.target.checked
                        ? [...current.modes, mode]
                        : current.modes.filter((item: LtmMode) => item !== mode),
                    }))
                  }
                  className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
                />
                {friendlyMode(mode)}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-2 rounded-lg bg-[var(--secondary)]/35 p-2 ring-1 ring-[var(--border)]">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Where this applies</div>
            <button
              type="button"
              onClick={useCurrentChatScope}
              disabled={!activeChat}
              className="rounded-md px-2 py-1 text-[0.6875rem] text-[var(--muted-foreground)] ring-1 ring-[var(--border)] hover:bg-[var(--secondary)] disabled:opacity-50"
            >
              Use this chat
            </button>
          </div>
          <LtmScopePicker
            value={{ chatIds: getLtmScopeChatIds(draft.scope), characterIds: draft.scope.characterIds ?? [] }}
            onChange={setLinkedScope}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              value={draft.scope.universe ?? ""}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  scope: { ...current.scope, universe: event.target.value || undefined },
                }))
              }
              onBlur={(event) =>
                setDraft((current) => ({
                  ...current,
                  scope: {
                    ...current.scope,
                    universe: normalizeIdentifier(event.target.value, "universe") || undefined,
                  },
                }))
              }
              placeholder="shared world"
              className={compactInputClassName}
            />
            <input
              value={draft.scope.rpId ?? ""}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  scope: { ...current.scope, rpId: event.target.value || undefined },
                }))
              }
              onBlur={(event) =>
                setDraft((current) => ({
                  ...current,
                  scope: { ...current.scope, rpId: normalizeIdentifier(event.target.value, "rp") || undefined },
                }))
              }
              placeholder="story line"
              className={compactInputClassName}
            />
            <input
              value={draft.scope.groupId ?? ""}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  scope: { ...current.scope, groupId: event.target.value || undefined },
                }))
              }
              placeholder="group"
              className={compactInputClassName}
            />
          </div>
          {sourceMemory && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--background)] p-2 ring-1 ring-[var(--border)]">
              <span className="text-[0.6875rem] text-[var(--muted-foreground)]">
                Push these chat and character links to extracted memories.
              </span>
              <ToolButton onClick={applyToDerived} disabled={busy}>
                {applyScopeToDerived.isPending ? (
                  <Loader2 size="0.875rem" className="animate-spin" />
                ) : (
                  <RefreshCw size="0.875rem" />
                )}
                Apply To Extracted Memories
              </ToolButton>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-medium text-[var(--foreground)]">Memory Details</h4>
            <ToolButton onClick={addSection}>
              <Plus size="0.875rem" />
              Add
            </ToolButton>
          </div>
          {Object.entries(draft.sections).map(([key, section]) => (
            <section key={key} className="rounded-lg bg-[var(--secondary)]/35 p-2 ring-1 ring-[var(--border)]">
              <div className="mb-2 grid grid-cols-[1fr_auto] gap-2">
                <input
                  defaultValue={key}
                  onBlur={(event) => renameSection(key, event.target.value)}
                  className={compactInputClassName}
                  aria-label={`Rename ${friendlySectionKey(key)}`}
                />
                <button
                  type="button"
                  onClick={() => removeSection(key)}
                  className="rounded-md px-2 text-[var(--destructive)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--destructive)]/10 active:scale-95"
                  aria-label={`Remove ${friendlySectionKey(key)}`}
                >
                  <Trash2 size="0.875rem" />
                </button>
              </div>
              <button
                type="button"
                onClick={() => setFloatingSectionKey(key)}
                className="group/summary flex min-h-24 w-full flex-col rounded-lg bg-[var(--background)] px-3 py-2 text-left text-xs text-[var(--foreground)] outline-none ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]/35 focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
              >
                <span className="mb-2 inline-flex items-center gap-1.5 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
                  <Pencil size="0.75rem" />
                  Edit memory text
                </span>
                <span
                  className={cn(
                    "line-clamp-4 whitespace-pre-wrap",
                    !section.text.trim() && "text-[var(--muted-foreground)]/70",
                  )}
                >
                  {section.text.trim() || "No memory text yet."}
                </span>
              </button>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={section.salience ?? ""}
                  onChange={(event) =>
                    setSection(key, (current) => ({ ...current, salience: numberOrUndefined(event.target.value) }))
                  }
                  placeholder="importance"
                  className={compactInputClassName}
                />
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={section.confidence ?? ""}
                  onChange={(event) =>
                    setSection(key, (current) => ({ ...current, confidence: numberOrUndefined(event.target.value) }))
                  }
                  placeholder="ai certainty"
                  className={compactInputClassName}
                />
              </div>
              <textarea
                value={section.evidence?.join("\n") ?? ""}
                onChange={(event) =>
                  setSection(key, (current) => ({
                    ...current,
                    evidence: event.target.value
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean),
                  }))
                }
                placeholder="Why this matters, one item per line"
                className={cn(textareaClassName, "mt-2 min-h-16")}
              />
            </section>
          ))}
          {floatingSectionKey && floatingSection && (
            <FloatingMessageEditor
              open
              title={`Edit ${friendlySectionKey(floatingSectionKey)}`}
              initialContent={floatingSection.text}
              fontSize={13}
              showFormatting
              onSave={(content) => {
                setSection(floatingSectionKey, (current) => ({
                  ...current,
                  text: content,
                }));
                setFloatingSectionKey(null);
              }}
              onCancel={() => setFloatingSectionKey(null)}
            />
          )}
        </div>

        <div className="space-y-2 rounded-lg bg-[var(--secondary)]/35 p-2 ring-1 ring-[var(--border)]">
          <h4 className="text-xs font-medium text-[var(--foreground)]">Related Memories</h4>
          {draft.links.map((link, index) => (
            <div
              key={`${link.target}-${link.relation}-${index}`}
              className="grid grid-cols-[1fr_auto] items-center gap-2 text-xs"
            >
              <div className="truncate text-[var(--muted-foreground)]">
                {friendlyIdentifier(link.relation)} &gt; {friendlyIdentifier(link.target)}
              </div>
              <button
                type="button"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    links: current.links.filter((_, linkIndex) => linkIndex !== index),
                  }))
                }
                className="rounded-md p-1 text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
                aria-label={`Remove relation ${friendlyIdentifier(link.relation)}`}
              >
                <X size="0.875rem" />
              </button>
            </div>
          ))}
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <input
              value={linkDraft.target}
              onChange={(event) => setLinkDraft((current) => ({ ...current, target: event.target.value }))}
              placeholder="related memory"
              className={compactInputClassName}
            />
            <input
              value={linkDraft.relation}
              onChange={(event) => setLinkDraft((current) => ({ ...current, relation: event.target.value }))}
              placeholder="relationship"
              className={compactInputClassName}
            />
            <ToolButton onClick={addLink}>
              <Plus size="0.875rem" />
              Add Relation
            </ToolButton>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-[var(--border)]/35 pt-3">
          <ToolButton onClick={() => save()} disabled={!dirty || busy} tone="primary">
            {updateNote.isPending ? <Loader2 size="0.875rem" className="animate-spin" /> : <Save size="0.875rem" />}
            Save
          </ToolButton>
          <ToolButton onClick={() => save({ rebuildAfter: true })} disabled={!dirty || busy}>
            {rebuild.isPending ? <Loader2 size="0.875rem" className="animate-spin" /> : <RefreshCw size="0.875rem" />}
            Save And Refresh Search
          </ToolButton>
          <ToolButton onClick={archive} disabled={busy || draft.status === "archived"} tone="danger">
            <Archive size="0.875rem" />
            Archive Memory
          </ToolButton>
          <ToolButton onClick={cancel} disabled={busy}>
            <X size="0.875rem" />
            Cancel
          </ToolButton>
        </div>
      </div>
      )}
    </div>
  );
}
