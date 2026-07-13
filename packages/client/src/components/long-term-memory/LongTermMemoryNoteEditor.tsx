import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import {
  getLtmScopeChatIds,
  isLtmSourceLikeNote,
  withMergedLtmScopeLinks,
  type LtmExtractionDroppedCandidate,
  type LtmImportance,
  type LtmLink,
  type LtmMode,
  type LtmNote,
  type LtmNoteType,
  type LtmSection,
} from "@marinara-engine/shared";
import {
  useApplyLongTermMemoryScopeToDerived,
  useRebuildLongTermMemory,
  useUpdateLongTermMemoryNote,
} from "../../hooks/use-long-term-memory";
import { useChat } from "../../hooks/use-chats";
import { cn } from "../../lib/utils";
import { showConfirmDialog } from "../../lib/app-dialogs";
import { useChatStore } from "../../stores/chat.store";
import { HelpTooltip } from "../ui/HelpTooltip";
import {
  actionRowClassName,
  compactInputClassName,
  helperTextClassName,
  insetSectionCardClassName,
  sectionCardClassName,
  SettingField,
  textareaClassName,
} from "./LtmFields";
import { LtmScopePicker } from "./LtmScopePicker";
import { LongTermMemorySuggestionsTab } from "./LongTermMemorySuggestionsTab";
import { type LtmManagedExtractionPrefs } from "./ltm-managed-extraction-prefs";
import type { LongTermMemoryLatestExtractionResult } from "../../stores/ltm-extraction-results.store";
import { ToolButton } from "./LtmPills";
import {
  dedupeEvidenceEntries,
  editablePatchFromDraft,
  emptySection,
  friendlyIdentifier,
  friendlyMode,
  friendlyNoteType,
  friendlySectionKey,
  friendlyStatus,
  groupScopeLabel,
  humanRelationLabel,
  modeOptions,
  normalizeIdentifier,
  normalizeKeywordsInput,
  normalizeTagsInput,
  noteTypeOptions,
  resolveEvidenceDisplay,
  statusOptions,
  type LtmDisplayLookupContext,
} from "./ltm-editor-utils";
import { ImportanceBadge } from "./ImportanceBadge";
import { LinkedContextPanel } from "./LinkedContextPanel";
import { RelationshipDimensionsEditor } from "./RelationshipDimensionsEditor";
import { LtmTabRail } from "./LtmTabRail";

type LongTermMemoryNoteEditorProps = {
  note: LtmNote;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: (note: LtmNote) => void;
  onRecoverDroppedCandidate?: (candidate: LtmExtractionDroppedCandidate, note: LtmNote) => void;
  extractionPrefs?: LtmManagedExtractionPrefs;
  embedded?: boolean;
  displayContext?: LtmDisplayLookupContext;
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
  return isLtmSourceLikeNote(note);
}

const importanceOptions: LtmImportance[] = ["critical", "major", "moderate", "minor"];
const linkRelationOptions: LtmLink["relation"][] = [
  "occurred_in",
  "triggered_by",
  "resolved_in",
  "evidenced_by",
  "affects_relationship",
  "affects_character",
  "caused_by",
  "involves",
  "blocks",
  "planted_in",
  "paid_off_in",
  "extracted_from",
];

type LinkDraft = {
  target: string;
  relation: LtmLink["relation"] | "";
  aspect: string;
};

export function LongTermMemoryNoteEditor({
  note,
  onCancel,
  onDirtyChange,
  onSaved,
  onRecoverDroppedCandidate,
  extractionPrefs,
  embedded = false,
  displayContext,
}: LongTermMemoryNoteEditorProps) {
  const activeChatId = useChatStore((state) => state.activeChatId);
  const cachedActiveChat = useChatStore((state) => state.activeChat);
  const activeChatQuery = useChat(activeChatId);
  const activeChat = activeChatQuery.data ?? cachedActiveChat;
  const [savedBaseline, setSavedBaseline] = useState(note);
  const [draft, setDraft] = useState(note);
  const [titleText, setTitleText] = useState(note.title ?? "");
  const [tagsText, setTagsText] = useState(note.tags.join(", "));
  const [keywordsText, setKeywordsText] = useState(note.keywords.join(", "));
  const [linkDraft, setLinkDraft] = useState<LinkDraft>({ target: "", relation: "", aspect: "" });
  const [activeTab, setActiveTab] = useState<"details" | "suggestions">("details");
  const [latestExtractionResult, setLatestExtractionResult] = useState<LongTermMemoryLatestExtractionResult | null>(
    null,
  );
  const updateNote = useUpdateLongTermMemoryNote();
  const applyScopeToDerived = useApplyLongTermMemoryScopeToDerived();
  const rebuild = useRebuildLongTermMemory();

  useEffect(() => {
    setSavedBaseline(note);
    setDraft(note);
    setTitleText(note.title ?? "");
    setTagsText(note.tags.join(", "));
    setKeywordsText(note.keywords.join(", "));
    setActiveTab("details");
    setLatestExtractionResult(null);
  }, [note]);

  const dirty = useMemo(() => serializedEditable(draft) !== serializedEditable(savedBaseline), [draft, savedBaseline]);
  const busy = updateNote.isPending || rebuild.isPending || applyScopeToDerived.isPending;
  const sourceMemory = isSourceMemory(draft);
  const typedNoteTypeOptions = noteTypeOptions.filter((type) => type !== "source");

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

  const cancel = async () => {
    if (
      dirty &&
      !(await showConfirmDialog({
        title: "Discard memory changes?",
        message: "Your unsaved changes to this memory will be lost.",
        confirmLabel: "Discard",
        tone: "destructive",
      }))
    ) {
      return;
    }
    onCancel();
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
    const relation = linkDraft.relation;
    const aspect = normalizeIdentifier(linkDraft.aspect, "aspect");
    if (!target || !relation) return;
    setDraft((current) => ({
      ...current,
      links: [...current.links, { target, relation, ...(aspect ? { aspect } : {}) }],
    }));
    setLinkDraft({ target: "", relation: "", aspect: "" });
  };

  const setLinkedScope = (next: { chatIds: string[]; characterIds: string[]; groupId?: string }) => {
    setDraft((current) => {
      const {
        chatId: _chatId,
        chatIds: _chatIds,
        characterIds: _characterIds,
        groupId: _groupId,
        ...restScope
      } = current.scope;
      return {
        ...current,
        scope: withMergedLtmScopeLinks(
          {
            ...restScope,
            groupId: next.groupId?.trim() || undefined,
          },
          { chatIds: next.chatIds, characterIds: next.characterIds },
        ),
      };
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

  const [advancedEvidenceKey, setAdvancedEvidenceKey] = useState<string | null>(null);
  const [advancedEvidenceValue, setAdvancedEvidenceValue] = useState("");

  const addEvidenceEntry = (sectionKey: string) => {
    const nextEntry = advancedEvidenceValue.trim();
    if (!nextEntry) return;
    setSection(sectionKey, (current) => ({
      ...current,
      evidence: dedupeEvidenceEntries([...(current.evidence ?? []), nextEntry], displayContext),
    }));
    setAdvancedEvidenceValue("");
    setAdvancedEvidenceKey(null);
  };

  return (
    <div className="grid gap-4">
      {!embedded && (
        <div className="rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[var(--foreground)]">{friendlyIdentifier(draft.id)}</div>
              <div className="mt-2 text-[0.6875rem] text-[var(--muted-foreground)]">
                {friendlyStatus(draft.status)} · updated {new Date(draft.updatedAt).toLocaleString()}
              </div>
            </div>
            {dirty ? (
              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[0.6875rem] font-semibold text-amber-700 dark:text-amber-200">
                Unsaved
              </span>
            ) : null}
          </div>
          <p className={cn("mt-2", helperTextClassName)}>
            Keep the note structure, scope, and supporting evidence aligned with the rest of the memory library.
          </p>
        </div>
      )}

      {!embedded && (
        <LtmTabRail
          tabs={[
            { id: "details" as const, label: "Details" },
            { id: "suggestions" as const, label: "Suggestions", disabled: !sourceMemory },
          ]}
          activeId={activeTab}
          onChange={setActiveTab}
          ariaLabel="Memory editor views"
          idPrefix="ltm-editor"
        />
      )}

      {!embedded && activeTab === "suggestions" && onRecoverDroppedCandidate ? (
        <div
          id="ltm-editor-panel-suggestions"
          role="tabpanel"
          aria-labelledby="ltm-editor-tab-suggestions"
          tabIndex={0}
        >
        <LongTermMemorySuggestionsTab
          note={savedBaseline}
          extractionPrefs={extractionPrefs}
          latestExtractionResult={latestExtractionResult}
          onLatestExtractionResultChange={setLatestExtractionResult}
          onRecoverDroppedCandidate={onRecoverDroppedCandidate}
        />
        </div>
      ) : null}

      {(embedded || activeTab === "details") && (
      <div
        id={embedded ? undefined : "ltm-editor-panel-details"}
        role={embedded ? undefined : "tabpanel"}
        aria-labelledby={embedded ? undefined : "ltm-editor-tab-details"}
        tabIndex={embedded ? undefined : 0}
        className="grid gap-4"
      >
        <SettingField label="Title">
          <input
            value={titleText}
            onChange={(event) => {
              const nextTitle = event.target.value;
              setTitleText(nextTitle);
              setDraft((current) => ({ ...current, title: nextTitle.trim() ? nextTitle : undefined }));
            }}
            placeholder={friendlyIdentifier(draft.id)}
            className={compactInputClassName}
          />
        </SettingField>

        <div className="grid gap-2 sm:grid-cols-2">
          <SettingField label="Type">
            {sourceMemory ? (
              <div className="grid gap-1">
                <div className={cn(compactInputClassName, "flex items-center")}>
                  {draft.type === "source" ? "Source" : friendlyNoteType(draft.type)}
                </div>
                <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
                  Source notes keep their type so extraction history stays linked.
                </p>
              </div>
            ) : (
              <select
                value={draft.type}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, type: event.target.value as LtmNoteType }))
                }
                className={compactInputClassName}
              >
                {typedNoteTypeOptions.map((type) => (
                  <option key={type} value={type}>
                    {friendlyNoteType(type)}
                  </option>
                ))}
              </select>
            )}
          </SettingField>
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
          <SettingField label="Keywords">
            <input
              value={keywordsText}
              onChange={(event) => setKeywordsText(event.target.value)}
              onBlur={() => setDraft((current) => ({ ...current, keywords: normalizeKeywordsInput(keywordsText) }))}
              className={compactInputClassName}
            />
          </SettingField>
        </div>

        <fieldset className={sectionCardClassName}>
          <legend className="px-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
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

        <div className={sectionCardClassName}>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                Where this applies
                <HelpTooltip
                  text="Scope controls which chats this memory applies to. The AI only retrieves memories matching your active context."
                  size="0.6875rem"
                />
              </div>
              <p className={cn("mt-1", helperTextClassName)}>
                Scope this memory to the right chats, characters, or group so recall stays predictable.
              </p>
            </div>
            <ToolButton onClick={useCurrentChatScope} disabled={!activeChat}>
              Use this chat
            </ToolButton>
          </div>
          <LtmScopePicker
            value={{
              chatIds: getLtmScopeChatIds(draft.scope),
              characterIds: draft.scope.characterIds ?? [],
              groupId: draft.scope.groupId,
            }}
            onChange={setLinkedScope}
          />
          {draft.scope.groupId && (
            <div className="text-[0.6875rem] text-[var(--muted-foreground)]">
              Grouped chat: {groupScopeLabel(draft.scope.groupId, displayContext) ?? "Grouped chat"}
            </div>
          )}
          {sourceMemory && (
            <div className={cn(insetSectionCardClassName, "flex flex-wrap items-center justify-between gap-2")}>
              <span className={helperTextClassName}>Push these chat and character links to extracted memories.</span>
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

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                Memory Details
              </h4>
              <p className={cn("mt-1", helperTextClassName)}>Edit each section, relevance score, and supporting evidence.</p>
            </div>
            <ToolButton onClick={addSection}>
              <Plus size="0.875rem" />
              Add
            </ToolButton>
          </div>
          {Object.entries(draft.sections).map(([key, section]) => (
            <section key={key} className={sectionCardClassName}>
              {section.importance && (
                <div className="mb-2 flex justify-end">
                  <ImportanceBadge importance={section.importance} />
                </div>
              )}
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
                  className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon mari-chrome-control--danger shrink-0"
                  aria-label={`Remove ${friendlySectionKey(key)}`}
                >
                  <Trash2 size="0.875rem" />
                </button>
              </div>
              <label className="block">
                <span className="mb-1 inline-flex items-center gap-1 text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
                  Memory Text
                </span>
                <textarea
                  value={section.text}
                  onChange={(event) =>
                    setSection(key, (current) => ({
                      ...current,
                      text: event.target.value,
                    }))
                  }
                  placeholder="No memory text yet."
                  className={cn(textareaClassName, "min-h-28")}
                />
              </label>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <label className="block">
                  <span className="mb-1 inline-flex items-center gap-1 text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
                    Relevance
                    <HelpTooltip
                      text="Higher values make this memory more likely to appear in the AI's context for the current chat."
                      size="0.625rem"
                    />
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={section.salience ?? ""}
                    onChange={(event) =>
                      setSection(key, (current) => ({ ...current, salience: numberOrUndefined(event.target.value) }))
                    }
                    placeholder="0-1"
                    className={compactInputClassName}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 inline-flex items-center gap-1 text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
                    AI Certainty
                    <HelpTooltip
                      text="How confident the AI was when creating this memory. Lower values mean the AI treats this as less reliable. Edit to override."
                      size="0.625rem"
                    />
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={section.confidence ?? ""}
                    onChange={(event) =>
                      setSection(key, (current) => ({ ...current, confidence: numberOrUndefined(event.target.value) }))
                    }
                    placeholder="0-1"
                    className={compactInputClassName}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 inline-flex items-center gap-1 text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
                    Importance
                  </span>
                  <select
                    value={section.importance ?? ""}
                    onChange={(event) =>
                      setSection(key, (current) => ({
                        ...current,
                        importance: event.target.value ? (event.target.value as LtmImportance) : undefined,
                      }))
                    }
                    className={compactInputClassName}
                  >
                    <option value="">Unspecified</option>
                    {importanceOptions.map((importance) => (
                      <option key={importance} value={importance}>
                        {friendlyIdentifier(importance)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {draft.type === "relationship" && (
                <div className="mt-3">
                  <RelationshipDimensionsEditor
                    dimensions={section.dimensions}
                    dimensionChanges={section.dimensionChanges}
                    onDimensionsChange={(dimensions) => setSection(key, (current) => ({ ...current, dimensions }))}
                    onDimensionChangesChange={(dimensionChanges) =>
                      setSection(key, (current) => ({ ...current, dimensionChanges }))
                    }
                  />
                </div>
              )}
              <label className="mt-3 block">
                <span className="mb-1 inline-flex items-center gap-1 text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
                  Supporting Evidence
                  <HelpTooltip
                    text="Reasons the AI created this memory. Each line is a source reference or justification."
                    size="0.625rem"
                  />
                </span>
                <div className="grid gap-2 rounded-xl bg-[var(--background)]/45 p-2 ring-1 ring-[var(--border)]/70">
                  {(section.evidence?.length ?? 0) > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {dedupeEvidenceEntries(section.evidence ?? [], displayContext).map((entry) => {
                        const resolved = resolveEvidenceDisplay(entry, displayContext);
                        return (
                          <span
                            key={`${key}-${entry}`}
                            title={resolved.tooltip}
                            className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--secondary)]/60 px-2 py-1 text-[0.6875rem] text-[var(--foreground)] ring-1 ring-[var(--border)]"
                          >
                            <span className="truncate">{resolved.label}</span>
                            <button
                              type="button"
                              onClick={() =>
                                setSection(key, (current) => ({
                                  ...current,
                                  evidence: (current.evidence ?? []).filter((candidate) => candidate !== entry),
                                }))
                              }
                              className="rounded p-0.5 hover:bg-[var(--accent)]"
                              aria-label={`Remove ${resolved.label}`}
                            >
                              <X size="0.7rem" />
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-[0.6875rem] text-[var(--muted-foreground)]">No supporting evidence yet.</p>
                  )}
                  {advancedEvidenceKey === key ? (
                    <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                      <input
                        value={advancedEvidenceValue}
                        onChange={(event) => setAdvancedEvidenceValue(event.target.value)}
                        placeholder="Advanced token, for example source_note:..."
                        className={compactInputClassName}
                      />
                      <ToolButton onClick={() => addEvidenceEntry(key)}>
                        <Check size="0.75rem" className="inline-block align-[-0.12rem]" /> Save
                      </ToolButton>
                      <ToolButton
                        onClick={() => {
                          setAdvancedEvidenceKey(null);
                          setAdvancedEvidenceValue("");
                        }}
                      >
                        Cancel
                      </ToolButton>
                    </div>
                  ) : (
                    <ToolButton onClick={() => setAdvancedEvidenceKey(key)}>Add Advanced Evidence</ToolButton>
                  )}
                </div>
              </label>
            </section>
          ))}
        </div>

        <div className={sectionCardClassName}>
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
              Related Memories
            </h4>
            <p className={cn("mt-1", helperTextClassName)}>
              Link this note to source notes, timeline events, or other memories.
            </p>
          </div>
          {draft.links.map((link, index) => (
            <div
              key={`${link.target}-${link.relation}-${index}`}
              className="grid grid-cols-[1fr_auto] items-center gap-2 rounded-lg bg-[var(--background)]/45 px-3 py-2 text-xs ring-1 ring-[var(--border)]/70"
            >
              <div className="min-w-0">
                <div className="text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                  {humanRelationLabel(link.relation)}
                </div>
                <div className="mt-0.5 truncate text-[var(--foreground)]">
                  {friendlyIdentifier(link.target)}
                  {link.aspect ? `, ${friendlyIdentifier(link.aspect)}` : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    links: current.links.filter((_, linkIndex) => linkIndex !== index),
                  }))
                }
                className="mari-chrome-control mari-chrome-control--small mari-chrome-control--icon mari-chrome-control--danger shrink-0"
                aria-label={`Remove relation ${friendlyIdentifier(link.relation)}`}
              >
                <X size="0.875rem" />
              </button>
            </div>
          ))}
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <input
              value={linkDraft.target}
              onChange={(event) => setLinkDraft((current) => ({ ...current, target: event.target.value }))}
              placeholder="related memory"
              className={compactInputClassName}
            />
            <select
              value={linkDraft.relation}
              onChange={(event) =>
                setLinkDraft((current) => ({ ...current, relation: event.target.value as LtmLink["relation"] }))
              }
              className={compactInputClassName}
            >
              <option value="">Relation</option>
              {linkRelationOptions.map((relation) => (
                <option key={relation} value={relation}>
                  {humanRelationLabel(relation)}
                </option>
              ))}
            </select>
            <input
              value={linkDraft.aspect}
              onChange={(event) => setLinkDraft((current) => ({ ...current, aspect: event.target.value }))}
              placeholder="aspect"
              className={compactInputClassName}
            />
            <ToolButton onClick={addLink}>
              <Plus size="0.875rem" />
              Add relation
            </ToolButton>
          </div>
        </div>

        <LinkedContextPanel note={draft} notes={displayContext?.notes} />

        <div className={actionRowClassName}>
          <ToolButton onClick={() => save()} disabled={!dirty || busy} tone="primary">
            {updateNote.isPending ? <Loader2 size="0.875rem" className="animate-spin" /> : <Save size="0.875rem" />}
            Save
          </ToolButton>
          <ToolButton onClick={() => save({ rebuildAfter: true })} disabled={!dirty || busy}>
            {rebuild.isPending ? <Loader2 size="0.875rem" className="animate-spin" /> : <RefreshCw size="0.875rem" />}
            Save and refresh search
          </ToolButton>
          <ToolButton onClick={() => void cancel()} disabled={busy}>
            <X size="0.875rem" />
            Cancel
          </ToolButton>
        </div>
      </div>
      )}
    </div>
  );
}
