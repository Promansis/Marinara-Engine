import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Archive,
  Check,
  DatabaseZap,
  Eye,
  EyeOff,
  FileJson,
  Hammer,
  History,
  Import,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type {
  LtmDraftMutation,
  LtmExtractionDraft,
  LtmLink,
  LtmNote,
  LtmNoteType,
  LtmStatus,
} from "@marinara-engine/shared";
import {
  useAcceptLongTermMemoryDraft,
  useArchiveLongTermMemoryNote,
  useImportLongTermMemorySourceNotes,
  useDeleteLongTermMemoryDraft,
  useLongTermMemoryDrafts,
  useLongTermMemoryImportPreview,
  useLongTermMemoryIntegrity,
  useLongTermMemoryNotes,
  useLongTermMemoryStatus,
  useRebuildLongTermMemory,
  useRejectLongTermMemoryDraft,
  useRepairLongTermMemory,
  useReplayLongTermMemory,
  useUpdateLongTermMemoryDraft,
  useUpdateLongTermMemoryNote,
  type UpdateLongTermMemoryDraftInput,
  type LtmInteropSource,
} from "../../hooks/use-long-term-memory";
import { useChatStore } from "../../stores/chat.store";
import { useChat, useUpdateChatMetadata } from "../../hooks/use-chats";
import { cn } from "../../lib/utils";
import {
  CreateLongTermMemoryNoteForm,
  type CreateLongTermMemoryNoteDraft,
} from "../long-term-memory/CreateLongTermMemoryNoteForm";
import { LongTermMemoryNoteEditor } from "../long-term-memory/LongTermMemoryNoteEditor";
import {
  friendlyIdentifier,
  friendlyMode,
  friendlyNoteTitle,
  friendlyNoteType,
  friendlySectionKey,
  friendlyStatus,
  sentenceCaseIdentifier,
} from "../long-term-memory/ltm-editor-utils";
import { SettingField } from "../long-term-memory/LtmFields";
import { StatusPill, ToolButton } from "../long-term-memory/LtmPills";
import { Modal } from "../ui/Modal";

const NOTE_TYPES: Array<"all" | LtmNoteType> = [
  "all",
  "character",
  "relationship",
  "scene",
  "thread",
  "callback",
  "world",
  "voice",
  "tone",
];
const NOTE_STATUSES: Array<"all" | Exclude<LtmStatus, "archived">> = ["all", "active", "dormant", "resolved"];
const IMPORT_SOURCES: Array<{ id: LtmInteropSource; label: string }> = [
  { id: "characters", label: "Characters" },
  { id: "lorebooks", label: "Lorebooks" },
  { id: "chats", label: "Chat Summaries" },
];

const TAB_LABELS: Record<TabId, string> = {
  notes: "Memories",
  drafts: "Suggestions",
  tools: "Maintenance",
  import: "Bring In",
};

type TabId = "notes" | "drafts" | "tools" | "import";
type ImportPreviewRow = NonNullable<ReturnType<typeof useLongTermMemoryImportPreview>["data"]>["samples"][number];

function importRowKey(source: LtmInteropSource, sourceId: string) {
  return `${source}:${sourceId}`;
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function SettingToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-2.5 rounded-lg p-1 transition-colors hover:bg-[var(--secondary)]/50",
        disabled && "pointer-events-none opacity-45",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3.5 w-3.5 shrink-0 rounded border-[var(--border)] accent-[var(--primary)]"
      />
      <span className="min-w-0 flex-1 text-xs text-[var(--foreground)]">{label}</span>
    </label>
  );
}

function normalizeScopeIdentifier(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!normalized) return "";
  return /^[a-z]/.test(normalized) ? normalized : `scope_${normalized}`;
}

function readScopeValue(metadata: Record<string, unknown>, key: "universe" | "rpId") {
  const scope = metadata.longTermMemoryScope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return "";
  const value = (scope as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="px-1 text-[0.6875rem] font-semibold uppercase text-[var(--muted-foreground)]">{title}</h3>
      {children}
    </section>
  );
}

function NoteRow({
  note,
  viewing,
  editing,
  onView,
  onEdit,
  onArchive,
  onRestore,
}: {
  note: LtmNote;
  viewing: boolean;
  editing: boolean;
  onView: () => void;
  onEdit: () => void;
  onArchive?: () => void;
  onRestore?: () => void;
}) {
  const sectionCount = Object.keys(note.sections).length;
  const primaryText =
    note.sections.summary?.text.trim() || note.sections.core?.text.trim() || Object.values(note.sections)[0]?.text.trim() || "";
  return (
    <article
      className={cn(
        "group rounded-xl border border-rose-300/15 bg-gradient-to-br from-rose-300/5 to-fuchsia-500/5 p-2.5 transition-all",
        "hover:border-rose-300/30 hover:bg-[var(--sidebar-accent)]",
        editing && "border-rose-300/40 bg-rose-300/10 ring-1 ring-rose-300/25",
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-[var(--foreground)]">{friendlyNoteTitle(note)}</div>
          {primaryText && (
            <div className="mt-1 line-clamp-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
              {primaryText}
            </div>
          )}
          <div className="mt-1 flex flex-wrap gap-1.5">
            <StatusPill label={friendlyNoteType(note.type)} />
            <StatusPill label={friendlyStatus(note.status)} tone={note.status === "active" ? "good" : "neutral"} />
            <StatusPill label={`${sectionCount} detail${sectionCount === 1 ? "" : "s"}`} />
          </div>
          <div className="mt-1 truncate text-[0.625rem] text-[var(--muted-foreground)]/80">Internal ID: {note.id}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onView}
            className={cn(
              "rounded-lg p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
              viewing && "bg-[var(--accent)] text-[var(--foreground)]",
            )}
            aria-label={`View ${friendlyNoteTitle(note)}`}
            title="View memory"
          >
            <Eye size="0.875rem" />
          </button>
          {onRestore ? (
            <button
              type="button"
              onClick={onRestore}
              className="rounded-lg p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-emerald-500/10 hover:text-emerald-200"
              aria-label={`Restore ${friendlyNoteTitle(note)}`}
              title="Restore memory"
            >
              <RotateCcw size="0.875rem" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onArchive}
              disabled={note.status === "archived"}
              className="rounded-lg p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)] disabled:cursor-not-allowed disabled:opacity-45"
              aria-label={`Archive ${friendlyNoteTitle(note)}`}
              title="Archive memory"
            >
              <Archive size="0.875rem" />
            </button>
          )}
          <button
            type="button"
            onClick={onEdit}
            className={cn(
              "rounded-lg p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
              editing && "bg-[var(--accent)] text-[var(--foreground)]",
            )}
            aria-label={`Edit ${friendlyNoteTitle(note)}`}
            title="Edit memory"
          >
            <Pencil size="0.875rem" />
          </button>
        </div>
      </div>
      {note.tags.length > 0 && (
        <div className="mt-2 truncate text-[0.625rem] text-[var(--muted-foreground)]">
          Tags: {note.tags.map(friendlyIdentifier).join(", ")}
        </div>
      )}
    </article>
  );
}

function compactScope(note: LtmNote) {
  const scopeEntries = Object.entries(note.scope).flatMap(([key, value]) => {
    if (Array.isArray(value)) return value.length ? [[key, value.join(", ")]] : [];
    return typeof value === "string" && value.trim() ? [[key, value]] : [];
  });
  return scopeEntries.length
    ? scopeEntries.map(([key, value]) => `${sentenceCaseIdentifier(key)}: ${friendlyIdentifier(value)}`).join(" · ")
    : "Available everywhere";
}

function mutationTarget(mutation: LtmDraftMutation) {
  if (mutation.kind === "create_note") return friendlyNoteTitle(mutation.note);
  if (mutation.kind === "add_link") {
    return `${friendlyIdentifier(mutation.noteId)} is related to ${friendlyIdentifier(mutation.link.target)}`;
  }
  return friendlyIdentifier(mutation.noteId);
}

function mutationKindLabel(kind: LtmDraftMutation["kind"]) {
  switch (kind) {
    case "create_note":
      return "New memory";
    case "append_section":
      return "Add detail";
    case "update_section":
      return "Rewrite detail";
    case "add_link":
      return "Related memory";
    case "set_status":
      return "Status change";
    case "flag_conflict":
      return "Needs review";
  }
}

function mutationRiskLabel(risk: LtmDraftMutation["risk"]) {
  if (risk === "low") return "Low risk";
  if (risk === "medium") return "Review";
  return "Careful";
}

function mutationText(mutation: LtmDraftMutation) {
  switch (mutation.kind) {
    case "create_note":
      return Object.entries(mutation.note.sections)
        .map(([key, section]) => `${friendlySectionKey(key)}: ${section.text}`)
        .join("\n\n");
    case "append_section":
      return `${friendlySectionKey(mutation.sectionKey)}: ${mutation.text}`;
    case "update_section":
      return `${friendlySectionKey(mutation.sectionKey)}: ${mutation.section.text}`;
    case "add_link":
      return `${friendlyIdentifier(mutation.noteId)} ${friendlyIdentifier(mutation.link.relation).toLowerCase()} ${friendlyIdentifier(
        mutation.link.target,
      )}`;
    case "set_status":
      return `Mark ${friendlyIdentifier(mutation.noteId)} as ${friendlyStatus(mutation.status).toLowerCase()}`;
    case "flag_conflict":
      return `${mutation.conflict.field}\nExisting: ${mutation.conflict.existing}\nProposed: ${mutation.conflict.proposed}`;
  }
}

function MutationPreview({ mutation }: { mutation: LtmDraftMutation }) {
  return (
    <article className="rounded-lg bg-[var(--secondary)]/45 p-3 ring-1 ring-[var(--border)]">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill label={mutationKindLabel(mutation.kind)} />
        <StatusPill
          label={mutationRiskLabel(mutation.risk)}
          tone={mutation.risk === "low" ? "good" : mutation.risk === "high" ? "bad" : "warn"}
        />
        <StatusPill label={`AI certainty ${Math.round(mutation.confidence * 100)}%`} />
      </div>
      <div className="mt-2 text-xs font-medium text-[var(--foreground)]">{mutation.summary}</div>
      <div className="mt-1 text-[0.625rem] text-[var(--muted-foreground)]">Applies to: {mutationTarget(mutation)}</div>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--background)] p-2 text-[0.6875rem] leading-relaxed text-[var(--foreground)] ring-1 ring-[var(--border)]">
        {mutationText(mutation)}
      </pre>
      {mutation.evidence.length > 0 && (
        <div className="mt-2 text-[0.625rem] text-[var(--muted-foreground)]">
          Evidence: {mutation.evidence.join(", ")}
        </div>
      )}
    </article>
  );
}

function GraphLinks({ links }: { links: LtmLink[] }) {
  if (links.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-3 text-xs text-[var(--muted-foreground)]">
        No related memories yet.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {links.map((link, index) => (
        <div
          key={`${link.relation}-${link.target}-${index}`}
          className="flex min-w-0 items-center gap-2 rounded-lg bg-[var(--secondary)]/45 px-3 py-2 text-xs ring-1 ring-[var(--border)]"
        >
          <span className="shrink-0 rounded-md bg-[var(--muted)]/50 px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
            {friendlyIdentifier(link.relation)}
          </span>
          <span className="min-w-0 truncate text-[var(--foreground)]">{friendlyIdentifier(link.target)}</span>
          <span className="truncate text-[0.625rem] text-[var(--muted-foreground)]">Internal ID: {link.target}</span>
        </div>
      ))}
    </div>
  );
}

function NoteViewModalContent({
  note,
  drafts,
  draftsLoading,
}: {
  note: LtmNote;
  drafts: LtmExtractionDraft[];
  draftsLoading: boolean;
}) {
  const extractedDrafts = drafts.filter((draft) => draft.source.sourceNoteId === note.id);
  const extractedMutations = extractedDrafts.flatMap((draft) => draft.mutations);
  const extractedLinks = extractedMutations.flatMap((mutation) => {
    if (mutation.kind === "create_note") return mutation.note.links;
    if (mutation.kind === "add_link") return [mutation.link];
    return [];
  });

  return (
    <div className="grid gap-4">
      <div className="rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
        <div className="flex min-w-0 flex-wrap gap-1.5">
          <StatusPill label={friendlyNoteType(note.type)} />
          <StatusPill label={friendlyStatus(note.status)} tone={note.status === "active" ? "good" : "neutral"} />
          {note.modes.map((mode) => (
            <StatusPill key={mode} label={friendlyMode(mode)} />
          ))}
        </div>
        <div className="mt-2 text-[0.625rem] text-[var(--muted-foreground)]">
          {compactScope(note)} · updated {new Date(note.updatedAt).toLocaleString()}
        </div>
      </div>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-[var(--foreground)]">Memory Details</h3>
        {Object.entries(note.sections).map(([key, section]) => (
          <article key={key} className="rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold text-[var(--foreground)]">{friendlySectionKey(key)}</span>
              {typeof section.salience === "number" && <StatusPill label={`Importance ${section.salience}`} />}
              {typeof section.confidence === "number" && <StatusPill label={`AI certainty ${section.confidence}`} />}
              {(section.gates ?? []).map((gate) => (
                <StatusPill key={gate} label={sentenceCaseIdentifier(gate)} tone="warn" />
              ))}
            </div>
            <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[var(--foreground)]">{section.text}</p>
            {(section.evidence ?? []).length > 0 && (
              <div className="mt-2 text-[0.625rem] text-[var(--muted-foreground)]">
                Evidence: {section.evidence?.join(", ")}
              </div>
            )}
          </article>
        ))}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-[var(--foreground)]">Related Memories</h3>
        <GraphLinks links={note.links} />
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-[var(--foreground)]">Suggestions From This Memory</h3>
          <StatusPill label={`${extractedMutations.length} suggested change${extractedMutations.length === 1 ? "" : "s"}`} />
        </div>
        {draftsLoading ? (
          <div className="flex items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-3 text-xs text-[var(--muted-foreground)]">
            <Loader2 className="mr-2 animate-spin" size="0.875rem" />
            Loading suggestions...
          </div>
        ) : extractedDrafts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-3 text-xs text-[var(--muted-foreground)]">
            No suggestions were created from this memory.
          </p>
        ) : (
          <div className="space-y-3">
            {extractedDrafts.map((draft) => (
              <article key={draft.id} className="rounded-lg bg-[var(--card)] p-3 ring-1 ring-[var(--border)]">
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusPill label={draftStatusLabel(draft.status)} tone={draftStatusTone(draft.status)} />
                  <StatusPill label={`${draft.mutations.length} suggested change${draft.mutations.length === 1 ? "" : "s"}`} />
                  {draft.appliedMutationIds?.length ? (
                    <StatusPill label={`${draft.appliedMutationIds.length} kept`} tone="good" />
                  ) : null}
                </div>
                {draft.summary && <p className="mt-2 text-xs text-[var(--foreground)]">{draft.summary}</p>}
                <div className="mt-3 space-y-2">
                  {draft.mutations.map((mutation) => (
                    <MutationPreview key={mutation.id} mutation={mutation} />
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
        {extractedLinks.length > 0 && (
          <div className="space-y-2">
            <div className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
              Related memories proposed by suggestions
            </div>
            <GraphLinks links={extractedLinks} />
          </div>
        )}
      </section>
    </div>
  );
}

function DraftRow({ draft }: { draft: LtmExtractionDraft }) {
  const accept = useAcceptLongTermMemoryDraft();
  const reject = useRejectLongTermMemoryDraft();
  const pending = draft.status === "pending";

  return (
    <article className="rounded-xl border border-rose-300/15 bg-gradient-to-br from-rose-300/5 to-fuchsia-500/5 p-2.5 transition-all hover:border-rose-300/30 hover:bg-[var(--sidebar-accent)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-[var(--foreground)]">{draft.summary || draft.id}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <StatusPill label={draftStatusLabel(draft.status)} tone={draftStatusTone(draft.status)} />
            <StatusPill label={`${draft.mutations.length} suggested change${draft.mutations.length === 1 ? "" : "s"}`} />
          </div>
          <div className="mt-1 truncate text-[0.625rem] text-[var(--muted-foreground)]/80">Internal ID: {draft.id}</div>
        </div>
      </div>
      {pending && (
        <div className="mt-3 flex flex-wrap gap-2">
          <ToolButton
            onClick={() =>
              accept
                .mutateAsync({ id: draft.id })
                .then(() => toast.success("Suggestion kept"))
                .catch((err: Error) => toast.error(err.message))
            }
            disabled={accept.isPending}
            tone="primary"
          >
            <Check size="0.875rem" />
            Keep
          </ToolButton>
          <ToolButton
            onClick={() =>
              reject
                .mutateAsync({ id: draft.id, reason: "Rejected from memory panel" })
                .then(() => toast.success("Suggestion skipped"))
                .catch((err: Error) => toast.error(err.message))
            }
            disabled={reject.isPending}
          >
            <X size="0.875rem" />
            Skip
          </ToolButton>
        </div>
      )}
    </article>
  );
}

function draftStatusTone(statusId: LtmExtractionDraft["status"]) {
  if (statusId === "pending") return "warn";
  if (statusId === "accepted" || statusId === "auto_applied") return "good";
  return "neutral";
}

function draftStatusLabel(statusId: LtmExtractionDraft["status"]) {
  if (statusId === "pending") return "Needs review";
  if (statusId === "accepted") return "Kept";
  if (statusId === "auto_applied") return "Kept automatically";
  return "Skipped";
}

function DraftDetails({ draft }: { draft: LtmExtractionDraft }) {
  return (
    <div className="grid gap-4">
      <div className="rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
        <div className="flex flex-wrap gap-1.5">
          <StatusPill label={draftStatusLabel(draft.status)} tone={draftStatusTone(draft.status)} />
          <StatusPill label={`${draft.mutations.length} suggested change${draft.mutations.length === 1 ? "" : "s"}`} />
          {draft.modes.map((mode) => (
            <StatusPill key={mode} label={friendlyMode(mode)} />
          ))}
        </div>
        <div className="mt-2 text-[0.625rem] text-[var(--muted-foreground)]">
          Created {new Date(draft.createdAt).toLocaleString()} · updated {new Date(draft.updatedAt).toLocaleString()}
        </div>
        {draft.rejectedReason && (
          <div className="mt-2 rounded-md bg-[var(--background)]/70 p-2 text-[0.6875rem] text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
            {draft.rejectedReason}
          </div>
        )}
      </div>

      {draft.summary && <p className="text-xs leading-relaxed text-[var(--foreground)]">{draft.summary}</p>}

      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-[var(--foreground)]">Suggested Changes</h3>
        {draft.mutations.map((mutation) => (
          <MutationPreview key={mutation.id} mutation={mutation} />
        ))}
      </section>
    </div>
  );
}

function DraftJsonEditor({
  draft,
  onSaved,
}: {
  draft: LtmExtractionDraft;
  onSaved?: (draft: LtmExtractionDraft) => void;
}) {
  const updateDraft = useUpdateLongTermMemoryDraft();
  const [text, setText] = useState(() => JSON.stringify(draft, null, 2));

  useEffect(() => {
    setText(JSON.stringify(draft, null, 2));
  }, [draft]);

  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      toast.error(`Suggestion JSON is invalid: ${(err as Error).message}`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      toast.error("Suggestion JSON must be an object.");
      return;
    }
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...patch } = parsed as Record<string, unknown>;
    try {
      const saved = await updateDraft.mutateAsync({
        id: draft.id,
        patch: patch as UpdateLongTermMemoryDraftInput,
      });
      toast.success("Suggestion saved");
      onSaved?.(saved);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="grid gap-3">
      <p className="text-xs text-[var(--muted-foreground)]">
        Advanced: edit the raw suggestion payload before restoring or keeping it archived.
      </p>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
        className="min-h-[24rem] w-full resize-y rounded-lg bg-[var(--background)] p-3 font-mono text-[0.6875rem] leading-relaxed text-[var(--foreground)] outline-none ring-1 ring-[var(--border)] focus:ring-[var(--primary)]"
      />
      <div className="flex justify-end">
        <ToolButton onClick={save} disabled={updateDraft.isPending} tone="primary">
          {updateDraft.isPending ? <Loader2 size="0.875rem" className="animate-spin" /> : <Save size="0.875rem" />}
          Save Suggestion
        </ToolButton>
      </div>
    </div>
  );
}

function ArchivedDraftRow({
  draft,
  selected,
  onView,
  onEdit,
  onRestore,
  onDelete,
}: {
  draft: LtmExtractionDraft;
  selected: boolean;
  onView: () => void;
  onEdit: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  return (
    <article
      className={cn(
        "rounded-xl border border-rose-300/15 bg-gradient-to-br from-rose-300/5 to-fuchsia-500/5 p-2.5 transition-all hover:border-rose-300/30 hover:bg-[var(--sidebar-accent)]",
        selected && "border-rose-300/40 bg-rose-300/10 ring-1 ring-rose-300/25",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-[var(--foreground)]">{draft.summary || draft.id}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <StatusPill label={draftStatusLabel(draft.status)} tone={draftStatusTone(draft.status)} />
            <StatusPill label={`${draft.mutations.length} suggested change${draft.mutations.length === 1 ? "" : "s"}`} />
          </div>
          <div className="mt-1 truncate text-[0.625rem] text-[var(--muted-foreground)]/80">Internal ID: {draft.id}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onView}
            className={cn(
              "rounded-lg p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
              selected && "bg-[var(--accent)] text-[var(--foreground)]",
            )}
            aria-label={`View suggestion ${draft.id}`}
            title="View suggestion"
          >
            <Eye size="0.875rem" />
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="rounded-lg p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
            aria-label={`Edit suggestion ${draft.id}`}
            title="Edit raw suggestion"
          >
            <Pencil size="0.875rem" />
          </button>
          <button
            type="button"
            onClick={onRestore}
            disabled={draft.status !== "rejected"}
            className="rounded-lg p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-emerald-500/10 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-45"
            aria-label={`Restore suggestion ${draft.id}`}
            title={draft.status === "rejected" ? "Restore suggestion" : "Kept suggestions cannot be restored"}
          >
            <RotateCcw size="0.875rem" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)]"
            aria-label={`Delete suggestion ${draft.id}`}
            title="Delete suggestion"
          >
            <Trash2 size="0.875rem" />
          </button>
        </div>
      </div>
      <div className="mt-2 truncate text-[0.625rem] text-[var(--muted-foreground)]">
        Updated {new Date(draft.updatedAt).toLocaleString()}
      </div>
    </article>
  );
}

function ImportPreviewRowItem({
  sample,
  selected,
  disabled,
  importing,
  hidden,
  onSelect,
  onImport,
  onToggleHidden,
}: {
  sample: ImportPreviewRow;
  selected: boolean;
  disabled?: boolean;
  importing?: boolean;
  hidden?: boolean;
  onSelect: (selected: boolean) => void;
  onImport: () => void;
  onToggleHidden: () => void;
}) {
  return (
    <article
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-lg bg-[var(--secondary)]/50 p-3 ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]/45 sm:grid-cols-[auto_minmax(0,1fr)_auto]",
        selected && "bg-rose-300/10 ring-rose-300/35",
      )}
    >
      <label className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--background)]/55 ring-1 ring-[var(--border)]">
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled}
          onChange={(event) => onSelect(event.target.checked)}
          className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
          aria-label={`Select ${sample.title}`}
        />
      </label>
      <div className="min-w-0 self-center">
        <div className="truncate text-xs font-medium text-[var(--foreground)]">{sample.title}</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <StatusPill label={`${sample.mutationCount} suggested change${sample.mutationCount === 1 ? "" : "s"}`} />
        </div>
      </div>
      <div className="col-span-2 flex shrink-0 items-center justify-end gap-1.5 sm:col-span-1">
        <button
          type="button"
          onClick={onImport}
          disabled={disabled || importing}
          className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-white transition-all hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {importing ? <Loader2 size="0.875rem" className="animate-spin" /> : <Import size="0.875rem" />}
          Import
        </button>
        <button
          type="button"
          onClick={onToggleHidden}
          disabled={disabled}
          className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg bg-[var(--secondary)] px-2.5 py-1.5 text-xs font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-all hover:bg-[var(--accent)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {hidden ? <Eye size="0.875rem" /> : <EyeOff size="0.875rem" />}
          {hidden ? "Unhide" : "Hide"}
        </button>
      </div>
    </article>
  );
}

function ChatMemorySettings() {
  const activeChatId = useChatStore((s) => s.activeChatId);
  const cachedActiveChat = useChatStore((s) => s.activeChat);
  const activeChatQuery = useChat(activeChatId);
  const activeChat = activeChatQuery.data ?? cachedActiveChat;
  const updateMeta = useUpdateChatMetadata();
  const metadata = useMemo(() => parseMetadata(activeChat?.metadata), [activeChat?.metadata]);
  const enabled = metadata.enableLongTermMemory === true;
  const debug = metadata.longTermMemoryDebug === true;
  const autoExtract = metadata.longTermMemoryAutoExtract === true;
  const autoApplyLowRisk = metadata.longTermMemoryAutoApplyLowRisk === true;
  const scopeUniverse = readScopeValue(metadata, "universe");
  const scopeRpId = readScopeValue(metadata, "rpId");
  const budgetValue =
    typeof metadata.longTermMemoryBudgetTokens === "number" && Number.isFinite(metadata.longTermMemoryBudgetTokens)
      ? Math.max(128, Math.min(16_384, Math.floor(metadata.longTermMemoryBudgetTokens)))
      : 2048;
  const [scopeDraft, setScopeDraft] = useState({
    universe: scopeUniverse,
    rpId: scopeRpId,
  });
  const [budgetDraft, setBudgetDraft] = useState(String(budgetValue));
  const sliderBudget = Number.isFinite(Number(budgetDraft))
    ? Math.max(128, Math.min(16_384, Math.floor(Number(budgetDraft))))
    : budgetValue;

  useEffect(() => {
    setScopeDraft({
      universe: scopeUniverse,
      rpId: scopeRpId,
    });
    setBudgetDraft(String(budgetValue));
  }, [activeChat?.id, budgetValue, scopeRpId, scopeUniverse]);

  if (!activeChat) {
    return <p className="text-xs text-[var(--muted-foreground)]">Open a chat to edit its long-term memory settings.</p>;
  }

  const patch = (next: Record<string, unknown>) =>
    updateMeta
      .mutateAsync({ id: activeChat.id, ...next })
      .then(() => toast.success("Chat memory settings updated"))
      .catch((err: Error) => toast.error(err.message));

  const commitScope = (draft = scopeDraft) => {
    const universe = normalizeScopeIdentifier(draft.universe);
    const rpId = normalizeScopeIdentifier(draft.rpId);
    setScopeDraft({ universe, rpId });
    if (universe === scopeUniverse && rpId === scopeRpId) {
      return Promise.resolve();
    }
    return patch({
      longTermMemoryScope: {
        ...(universe ? { universe } : {}),
        ...(rpId ? { rpId } : {}),
      },
    });
  };

  const commitBudget = (value: string) => {
    const numeric = Number(value);
    const next = Number.isFinite(numeric) ? Math.max(128, Math.min(16_384, Math.floor(numeric))) : 2048;
    setBudgetDraft(String(next));
    if (next === budgetValue) return Promise.resolve();
    return patch({ longTermMemoryBudgetTokens: next });
  };

  return (
    <div className="space-y-2">
      <SettingToggle
        label="Use memory in prompts"
        checked={enabled}
        onChange={(checked) => patch({ enableLongTermMemory: checked })}
      />

      <div className="grid gap-3 rounded-xl border border-rose-300/15 bg-gradient-to-br from-rose-300/5 to-fuchsia-500/5 p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <SettingField label="Universe">
            <input
              value={scopeDraft.universe}
              onChange={(event) => setScopeDraft((current) => ({ ...current, universe: event.target.value }))}
              onBlur={() => commitScope()}
              placeholder="shared_realm"
              className="w-full rounded-lg bg-[var(--background)] px-3 py-2 text-xs text-[var(--foreground)] outline-none ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:ring-[var(--primary)]"
            />
          </SettingField>
          <SettingField label="Story line">
            <input
              value={scopeDraft.rpId}
              onChange={(event) => setScopeDraft((current) => ({ ...current, rpId: event.target.value }))}
              onBlur={() => commitScope()}
              placeholder="main_story"
              className="w-full rounded-lg bg-[var(--background)] px-3 py-2 text-xs text-[var(--foreground)] outline-none ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:ring-[var(--primary)]"
            />
          </SettingField>
        </div>

        <SettingField label="Memory space used in replies">
          <div className="grid grid-cols-[1fr_5.5rem] items-center gap-3">
            <input
              type="range"
              min={128}
              max={16384}
              step={128}
              value={sliderBudget}
              onChange={(event) => setBudgetDraft(event.target.value)}
              onPointerUp={(event) => commitBudget((event.target as HTMLInputElement).value)}
              onBlur={(event) => commitBudget(event.target.value)}
              className="min-w-0 accent-[var(--primary)]"
            />
            <input
              type="number"
              min={128}
              max={16384}
              step={128}
              value={budgetDraft}
              onChange={(event) => setBudgetDraft(event.target.value)}
              onBlur={(event) => commitBudget(event.target.value)}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-xs outline-none focus:border-[var(--primary)]"
            />
          </div>
        </SettingField>
      </div>

      <SettingToggle
        label="Debug retrieval logs"
        checked={debug}
        onChange={(checked) => patch({ longTermMemoryDebug: checked })}
      />
      <SettingToggle
        label="Create drafts after replies"
        checked={autoExtract}
        onChange={(checked) =>
          patch({
            longTermMemoryAutoExtract: checked,
            ...(checked ? {} : { longTermMemoryAutoApplyLowRisk: false }),
          })
        }
      />
      <SettingToggle
        label="Auto-apply low-risk drafts"
        checked={autoExtract && autoApplyLowRisk}
        disabled={!autoExtract}
        onChange={(checked) =>
          patch({
            longTermMemoryAutoExtract: true,
            longTermMemoryAutoApplyLowRisk: checked,
          })
        }
      />
    </div>
  );
}

export function LongTermMemoryPanel() {
  const [tab, setTab] = useState<TabId>("notes");
  const [noteType, setNoteType] = useState<"all" | LtmNoteType>("all");
  const [noteStatus, setNoteStatus] = useState<"all" | Exclude<LtmStatus, "archived">>("all");
  const [query, setQuery] = useState("");
  const [importSource, setImportSource] = useState<LtmInteropSource>("characters");
  const [importLimit, setImportLimit] = useState(25);
  const [hiddenImportRows, setHiddenImportRows] = useState<Set<string>>(() => new Set());
  const [selectedImportRows, setSelectedImportRows] = useState<Set<string>>(() => new Set());
  const [showHiddenImportRows, setShowHiddenImportRows] = useState(false);
  const [activeImportIds, setActiveImportIds] = useState<Set<string>>(() => new Set());
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveTab, setArchiveTab] = useState<"notes" | "drafts">("notes");
  const [creatingNote, setCreatingNote] = useState(false);
  const [createNoteDraft, setCreateNoteDraft] = useState<CreateLongTermMemoryNoteDraft | null>(null);
  const [createNoteDirty, setCreateNoteDirty] = useState(false);
  const [viewingNoteId, setViewingNoteId] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editedNoteDirty, setEditedNoteDirty] = useState(false);
  const [viewingDraftId, setViewingDraftId] = useState<string | null>(null);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);

  const status = useLongTermMemoryStatus();
  const integrity = useLongTermMemoryIntegrity();
  const notes = useLongTermMemoryNotes({
    type: noteType === "all" ? undefined : noteType,
    status: noteStatus === "all" ? undefined : noteStatus,
  });
  const archivedNotes = useLongTermMemoryNotes(
    { status: "archived" },
    { enabled: archiveOpen || Boolean(viewingNoteId) || Boolean(editingNoteId) },
  );
  const drafts = useLongTermMemoryDrafts({ status: "pending" });
  const allDrafts = useLongTermMemoryDrafts(
    {},
    { enabled: archiveOpen || Boolean(viewingNoteId) || Boolean(viewingDraftId) || Boolean(editingDraftId) },
  );
  const importPreview = useLongTermMemoryImportPreview(importSource, importLimit);
  const rebuild = useRebuildLongTermMemory();
  const replay = useReplayLongTermMemory();
  const repair = useRepairLongTermMemory();
  const importSourceNotes = useImportLongTermMemorySourceNotes();
  const archiveNote = useArchiveLongTermMemoryNote();
  const updateNote = useUpdateLongTermMemoryNote();
  const updateDraft = useUpdateLongTermMemoryDraft();
  const deleteDraft = useDeleteLongTermMemoryDraft();

  const filteredNotes = useMemo(() => {
    const list = (notes.data ?? []).filter((note) => note.status !== "archived");
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (note) =>
        note.id.toLowerCase().includes(needle) ||
        note.tags.some((tag) => tag.toLowerCase().includes(needle)) ||
        Object.values(note.sections).some((section) => section.text.toLowerCase().includes(needle)),
    );
  }, [notes.data, query]);

  const filteredDrafts = drafts.data ?? [];
  const archivedDrafts = useMemo(
    () => (allDrafts.data ?? []).filter((draft) => draft.status !== "pending"),
    [allDrafts.data],
  );
  const importRows = useMemo(() => importPreview.data?.samples ?? [], [importPreview.data?.samples]);
  const visibleImportRows = useMemo(
    () =>
      importRows.filter((sample) => {
        const key = importRowKey(importSource, sample.sourceId);
        return showHiddenImportRows ? hiddenImportRows.has(key) : !hiddenImportRows.has(key);
      }),
    [hiddenImportRows, importRows, importSource, showHiddenImportRows],
  );
  const selectedVisibleImportRows = useMemo(
    () =>
      visibleImportRows.filter((sample) => selectedImportRows.has(importRowKey(importSource, sample.sourceId))),
    [importSource, selectedImportRows, visibleImportRows],
  );
  const hiddenImportRowCount = importRows.filter((sample) =>
    hiddenImportRows.has(importRowKey(importSource, sample.sourceId)),
  ).length;
  const allVisibleImportRowsSelected =
    visibleImportRows.length > 0 &&
    visibleImportRows.every((sample) => selectedImportRows.has(importRowKey(importSource, sample.sourceId)));
  const combinedNotes = useMemo(() => {
    const byId = new Map<string, LtmNote>();
    for (const note of notes.data ?? []) byId.set(note.id, note);
    for (const note of archivedNotes.data ?? []) byId.set(note.id, note);
    return [...byId.values()];
  }, [archivedNotes.data, notes.data]);
  const statusTone = integrity.data?.ok ? "good" : integrity.data ? "bad" : "neutral";
  const editingNote = useMemo(
    () => (editingNoteId ? (combinedNotes.find((note) => note.id === editingNoteId) ?? null) : null),
    [combinedNotes, editingNoteId],
  );
  const viewingNote = useMemo(
    () => (viewingNoteId ? (combinedNotes.find((note) => note.id === viewingNoteId) ?? null) : null),
    [combinedNotes, viewingNoteId],
  );
  const viewingDraft = useMemo(
    () => (viewingDraftId ? ((allDrafts.data ?? []).find((draft) => draft.id === viewingDraftId) ?? null) : null),
    [allDrafts.data, viewingDraftId],
  );
  const editingDraft = useMemo(
    () => (editingDraftId ? ((allDrafts.data ?? []).find((draft) => draft.id === editingDraftId) ?? null) : null),
    [allDrafts.data, editingDraftId],
  );
  const editedNoteFilteredOut = Boolean(editingNote && !filteredNotes.some((note) => note.id === editingNote.id));
  const editingNoteHiddenByFilters = Boolean(editedNoteFilteredOut && editingNote);

  const closeEditor = () => {
    setEditingNoteId(null);
    setEditedNoteDirty(false);
  };

  const closeViewer = () => {
    setViewingNoteId(null);
  };

  const closeDraftViewer = () => {
    setViewingDraftId(null);
  };

  const closeDraftEditor = () => {
    setEditingDraftId(null);
  };

  const closeCreateForm = () => {
    setCreatingNote(false);
    setCreateNoteDirty(false);
    setCreateNoteDraft(null);
  };

  const confirmDiscardCreate = () => !createNoteDirty || confirm("Discard unsaved memory draft?");

  const confirmDiscardEditor = () => !editedNoteDirty || confirm("Discard unsaved memory changes?");

  const setTabWithGuards = (nextTab: TabId) => {
    if (nextTab === tab) return;
    if (creatingNote && !confirmDiscardCreate()) return;
    if (editingNoteId && !confirmDiscardEditor()) return;
    if (creatingNote) closeCreateForm();
    if (editingNoteId) closeEditor();
    if (viewingNoteId) closeViewer();
    if (viewingDraftId) closeDraftViewer();
    if (editingDraftId) closeDraftEditor();
    setTab(nextTab);
  };

  const requestViewNote = (id: string) => {
    if (viewingNoteId === id) {
      closeViewer();
      return;
    }
    setViewingNoteId(id);
  };

  const requestEditNote = (id: string) => {
    if (editingNoteId === id) {
      return;
    }
    if (creatingNote && !confirmDiscardCreate()) return;
    if (!confirmDiscardEditor()) return;
    closeCreateForm();
    closeViewer();
    closeDraftViewer();
    closeDraftEditor();
    setEditingNoteId(id);
    setEditedNoteDirty(false);
  };

  const requestCreateNote = () => {
    if (creatingNote) return;
    if (!confirmDiscardEditor()) return;
    setEditingNoteId(null);
    setEditedNoteDirty(false);
    closeViewer();
    closeDraftViewer();
    closeDraftEditor();
    setCreatingNote(true);
  };

  const archiveFromRow = (note: LtmNote) => {
    if (!confirm(`Archive ${friendlyNoteTitle(note)}?`)) return;
    archiveNote
      .mutateAsync(note.id)
      .then((result) => {
        toast.success("Memory archived");
        if (editingNoteId === result.note.id) closeEditor();
      })
      .catch((err: Error) => toast.error(err.message));
  };

  const restoreNote = (note: LtmNote) => {
    updateNote
      .mutateAsync({ id: note.id, patch: { status: "active" } })
      .then((saved) => {
        toast.success("Memory restored");
        setArchiveOpen(false);
        setViewingNoteId(null);
        setEditingNoteId(saved.id);
        setEditedNoteDirty(false);
      })
      .catch((err: Error) => toast.error(err.message));
  };

  const restoreDraft = (draft: LtmExtractionDraft) => {
    if (draft.status !== "rejected") return;
    updateDraft
      .mutateAsync({ id: draft.id, patch: { status: "pending" } })
      .then(() => {
        toast.success("Suggestion restored");
        setViewingDraftId(null);
        setEditingDraftId(null);
      })
      .catch((err: Error) => toast.error(err.message));
  };

  const deleteArchivedDraft = (draft: LtmExtractionDraft) => {
    if (!confirm(`Delete suggestion ${draft.id}? This cannot be undone.`)) return;
    deleteDraft
      .mutateAsync(draft.id)
      .then(() => {
        toast.success("Suggestion deleted");
        if (viewingDraftId === draft.id) closeDraftViewer();
        if (editingDraftId === draft.id) closeDraftEditor();
      })
      .catch((err: Error) => toast.error(err.message));
  };

  const setImportRowSelected = (sourceId: string, selected: boolean) => {
    const key = importRowKey(importSource, sourceId);
    setSelectedImportRows((current) => {
      const next = new Set(current);
      if (selected) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const setAllVisibleImportRowsSelected = (selected: boolean) => {
    setSelectedImportRows((current) => {
      const next = new Set(current);
      for (const row of visibleImportRows) {
        const key = importRowKey(importSource, row.sourceId);
        if (selected) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  const hideImportRows = (sourceIds: string[]) => {
    setHiddenImportRows((current) => {
      const next = new Set(current);
      for (const sourceId of sourceIds) next.add(importRowKey(importSource, sourceId));
      return next;
    });
    setSelectedImportRows((current) => {
      const next = new Set(current);
      for (const sourceId of sourceIds) next.delete(importRowKey(importSource, sourceId));
      return next;
    });
  };

  const unhideImportRows = (sourceIds: string[]) => {
    setHiddenImportRows((current) => {
      const next = new Set(current);
      for (const sourceId of sourceIds) next.delete(importRowKey(importSource, sourceId));
      return next;
    });
    setSelectedImportRows((current) => {
      const next = new Set(current);
      for (const sourceId of sourceIds) next.delete(importRowKey(importSource, sourceId));
      return next;
    });
  };

  const restoreHiddenImportRows = () => {
    setHiddenImportRows((current) => {
      const next = new Set(current);
      for (const row of importRows) next.delete(importRowKey(importSource, row.sourceId));
      return next;
    });
  };

  const importRowsToVault = async (sourceIds: string[]) => {
    if (sourceIds.length === 0) return;
    setActiveImportIds((current) => {
      const next = new Set(current);
      for (const sourceId of sourceIds) next.add(importRowKey(importSource, sourceId));
      return next;
    });
    try {
      const result = await importSourceNotes.mutateAsync({
        source: importSource,
        sourceIds,
        limit: Math.max(importLimit, sourceIds.length),
      });
      const errorCount = result.imported.filter((item) =>
        item.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      ).length;
      const draftCount = result.imported.filter((item) => item.draft).length;
      const missingCount = result.missingSourceIds.length;
      if (errorCount || missingCount) {
        const firstError = result.imported
          .flatMap((item) => item.diagnostics)
          .find((diagnostic) => diagnostic.severity === "error");
        const issueDetails = [
          firstError?.message,
          missingCount ? `Missing: ${result.missingSourceIds.slice(0, 3).join(", ")}` : null,
        ].filter(Boolean);
        toast.error(
          `Imported ${result.imported.length} source note(s), ${draftCount} extraction draft(s), ${errorCount + missingCount} issue(s)${
            issueDetails.length ? `: ${issueDetails.join("; ")}` : ""
          }`,
        );
      } else {
        toast.success(`Imported ${result.imported.length} source note(s), created ${draftCount} extraction draft(s)`);
      }
      setSelectedImportRows((current) => {
        const next = new Set(current);
        for (const sourceId of sourceIds) next.delete(importRowKey(importSource, sourceId));
        return next;
      });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setActiveImportIds((current) => {
        const next = new Set(current);
        for (const sourceId of sourceIds) next.delete(importRowKey(importSource, sourceId));
        return next;
      });
    }
  };

  return (
    <div className="flex min-h-full flex-col gap-2 p-3 text-[var(--foreground)]">
      <section className="rounded-xl border border-rose-300/20 bg-gradient-to-br from-rose-300/5 to-fuchsia-500/5 p-3">
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3">
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-[var(--foreground)]">Story Memory</div>
            <div className="mt-1 truncate text-[0.625rem] text-[var(--muted-foreground)]">
              Advanced folder: {status.data?.directory ?? "long-term-memory"}
            </div>
          </div>
          <div className="text-right">
            <div className="text-base font-semibold tabular-nums text-[var(--foreground)]">
              {status.data?.notes.total ?? 0}
            </div>
            <div className="text-[0.5625rem] uppercase text-[var(--muted-foreground)]">Memories</div>
          </div>
          <div className="text-right">
            <div className="text-base font-semibold tabular-nums text-[var(--foreground)]">
              {status.data?.indexes.chunkCount ?? 0}
            </div>
            <div className="text-[0.5625rem] uppercase text-[var(--muted-foreground)]">Search bits</div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <StatusPill label={integrity.data?.ok ? "Healthy" : "Needs check"} tone={statusTone} />
          <StatusPill
            label={status.data?.indexes.embeddingsAvailable ? "Smart search" : "Basic search"}
            tone="neutral"
          />
          <button
            type="button"
            onClick={() => setArchiveOpen(true)}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--muted)]/40 px-1.5 py-0.5 text-[0.625rem] font-medium leading-tight text-[var(--muted-foreground)] transition-colors hover:border-rose-300/30 hover:bg-rose-300/10 hover:text-[var(--foreground)]"
          >
            <Archive size="0.75rem" />
            Archived
          </button>
        </div>
      </section>

      <div className="sticky top-0 z-10 grid grid-cols-4 gap-1 rounded-xl bg-[var(--background)]/95 py-1 backdrop-blur-sm">
        {(["notes", "drafts", "tools", "import"] as TabId[]).map((id) => (
          <button
            key={id}
            onClick={() => setTabWithGuards(id)}
            className={cn(
              "min-w-0 rounded-lg px-2 py-1.5 text-xs font-medium transition-all active:scale-[0.98]",
              tab === id
                ? "bg-rose-300/15 text-[var(--foreground)] ring-1 ring-rose-300/30"
                : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
            )}
          >
            {TAB_LABELS[id]}
          </button>
        ))}
      </div>

      {tab === "notes" && (
        <Section title="Memories">
          <div className="mb-3 grid grid-cols-[1fr_auto] gap-2">
            <div className="flex items-center gap-2 rounded-xl bg-[var(--secondary)] px-3 py-2 ring-1 ring-[var(--border)] transition-shadow focus-within:ring-[var(--ring)]">
              <Search size="0.875rem" className="text-[var(--muted-foreground)]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search memories"
                className="min-w-0 flex-1 bg-transparent text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]/60"
              />
            </div>
            <ToolButton onClick={requestCreateNote} disabled={creatingNote}>
              <Plus size="0.875rem" />
              New
            </ToolButton>
          </div>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <select
              value={noteType}
              onChange={(event) => setNoteType(event.target.value as "all" | LtmNoteType)}
              className="rounded-lg bg-[var(--secondary)] px-2.5 py-2 text-xs outline-none ring-1 ring-transparent focus:ring-[var(--primary)]"
            >
              {NOTE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type === "all" ? "All types" : friendlyNoteType(type)}
                </option>
              ))}
            </select>
            <select
              value={noteStatus}
              onChange={(event) => setNoteStatus(event.target.value as "all" | Exclude<LtmStatus, "archived">)}
              className="rounded-lg bg-[var(--secondary)] px-2.5 py-2 text-xs outline-none ring-1 ring-transparent focus:ring-[var(--primary)]"
            >
              {NOTE_STATUSES.map((statusId) => (
                <option key={statusId} value={statusId}>
                  {statusId === "all" ? "Any status" : friendlyStatus(statusId)}
                </option>
              ))}
            </select>
          </div>
          {editingNoteHiddenByFilters && (
            <div className="mb-3 rounded-lg bg-amber-500/10 p-3 ring-1 ring-amber-400/30">
              <div className="text-xs font-medium text-amber-100">Open note is hidden by filters</div>
              <p className="mt-1 text-[0.6875rem] text-amber-100/80">
                The editor stays open so unsaved edits are not lost.
              </p>
            </div>
          )}
          <div className="space-y-2">
            {notes.isLoading && <Loader2 className="mx-auto animate-spin text-[var(--muted-foreground)]" />}
            {!notes.isLoading && filteredNotes.length === 0 && (
              <p className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-center text-xs text-[var(--muted-foreground)]">
                No matching memories.
              </p>
            )}
            {filteredNotes.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                viewing={viewingNoteId === note.id}
                editing={editingNoteId === note.id}
                onView={() => requestViewNote(note.id)}
                onEdit={() => requestEditNote(note.id)}
                onArchive={() => archiveFromRow(note)}
              />
            ))}
          </div>
        </Section>
      )}

      {tab === "drafts" && (
        <Section title="Suggestions To Review">
          <div className="space-y-2">
            {filteredDrafts.length === 0 && (
              <p className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-center text-xs text-[var(--muted-foreground)]">
                No suggestions need review.
              </p>
            )}
            {filteredDrafts.map((draft) => (
              <DraftRow key={draft.id} draft={draft} />
            ))}
          </div>
        </Section>
      )}

      {tab === "tools" && (
        <>
          <Section title="Chat Settings">
            <ChatMemorySettings />
          </Section>
          <Section title="Refresh And Repair">
            <div className="space-y-2">
              <ToolButton
                onClick={() =>
                  rebuild
                    .mutateAsync()
                .then(() => toast.success("Memory search refreshed"))
                    .catch((err: Error) => toast.error(err.message))
                }
                disabled={rebuild.isPending}
                tone="primary"
              >
                <RefreshCw size="0.875rem" />
                Refresh Memory Search
              </ToolButton>
              <ToolButton
                onClick={() =>
                  replay
                    .mutateAsync()
                    .then((result) => toast(result.replayable ? "Memory history looks healthy" : result.messages[0]))
                    .catch((err: Error) => toast.error(err.message))
                }
                disabled={replay.isPending}
              >
                <History size="0.875rem" />
                Check Memory History
              </ToolButton>
              <ToolButton
                onClick={() =>
                  repair
                    .mutateAsync(["quarantine_malformed_notes", "rebuild_indexes"])
                    .then(() => toast.success("Repair actions finished"))
                    .catch((err: Error) => toast.error(err.message))
                }
                disabled={repair.isPending}
                tone="danger"
              >
                <Hammer size="0.875rem" />
                Repair Broken Memory Files
              </ToolButton>
            </div>
            <div className="mt-3 space-y-2">
              {(integrity.data?.issues ?? []).slice(0, 8).map((issue) => (
                <div
                  key={`${issue.code}-${issue.path ?? issue.noteId ?? issue.message}`}
                  className="rounded-lg bg-[var(--secondary)]/50 p-3 text-xs ring-1 ring-[var(--border)]"
                >
                  <div className="flex items-center gap-2 font-medium">
                    {issue.severity === "error" ? (
                      <AlertTriangle size="0.875rem" className="text-rose-300" />
                    ) : (
                      <ShieldCheck size="0.875rem" />
                    )}
                    {issue.code}
                  </div>
                  <p className="mt-1 text-xs text-[var(--muted-foreground)]">{issue.message}</p>
                </div>
              ))}
            </div>
          </Section>
        </>
      )}

      {tab === "import" && (
        <Section title="Bring Existing Stories In">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <select
              value={importSource}
              onChange={(event) => setImportSource(event.target.value as LtmInteropSource)}
              className="rounded-lg bg-[var(--secondary)] px-2.5 py-2 text-xs outline-none ring-1 ring-transparent focus:ring-[var(--primary)]"
            >
              {IMPORT_SOURCES.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.id === "chats" ? "Chat summaries" : source.label}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              max={100}
              value={importLimit}
              onChange={(event) => setImportLimit(Number(event.target.value))}
              className="w-20 rounded-lg bg-[var(--secondary)] px-2.5 py-2 text-xs outline-none ring-1 ring-transparent focus:ring-[var(--primary)]"
            />
          </div>
          <div className="mt-3 rounded-lg bg-[var(--secondary)]/50 p-3 ring-1 ring-[var(--border)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-medium text-[var(--foreground)]">
                  {importPreview.data?.draftable ?? 0} source{importPreview.data?.draftable === 1 ? "" : "s"} ready
                </div>
              </div>
              {importPreview.isLoading ? <Loader2 className="animate-spin" size="1rem" /> : <FileJson size="1rem" />}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-[var(--secondary)]/35 p-2 ring-1 ring-[var(--border)]">
            <label className="flex min-h-8 items-center gap-2 rounded-lg px-2 text-xs text-[var(--foreground)]">
              <input
                type="checkbox"
                checked={allVisibleImportRowsSelected}
                disabled={visibleImportRows.length === 0}
                onChange={(event) => setAllVisibleImportRowsSelected(event.target.checked)}
                className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
              />
              Select visible
            </label>
            <ToolButton
              onClick={() => importRowsToVault(selectedVisibleImportRows.map((row) => row.sourceId))}
              disabled={selectedVisibleImportRows.length === 0 || importSourceNotes.isPending}
              tone="primary"
            >
              {importSourceNotes.isPending ? (
                <Loader2 size="0.875rem" className="animate-spin" />
              ) : (
                <Import size="0.875rem" />
              )}
              Bring in selected
            </ToolButton>
            <ToolButton
              onClick={() =>
                showHiddenImportRows
                  ? unhideImportRows(selectedVisibleImportRows.map((row) => row.sourceId))
                  : hideImportRows(selectedVisibleImportRows.map((row) => row.sourceId))
              }
              disabled={selectedVisibleImportRows.length === 0}
            >
              {showHiddenImportRows ? <Eye size="0.875rem" /> : <EyeOff size="0.875rem" />}
              {showHiddenImportRows ? "Unhide selected" : "Hide selected"}
            </ToolButton>
            <button
              type="button"
              onClick={() => setShowHiddenImportRows((open) => !open)}
              disabled={!showHiddenImportRows && hiddenImportRowCount === 0}
              className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg bg-[var(--secondary)] px-3 py-2 text-xs font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-all hover:bg-[var(--accent)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Eye size="0.875rem" />
              {showHiddenImportRows ? "Show active" : `Show hidden (${hiddenImportRowCount})`}
            </button>
            {showHiddenImportRows && hiddenImportRowCount > 0 && (
              <ToolButton onClick={restoreHiddenImportRows}>
                <RotateCcw size="0.875rem" />
                Restore hidden
              </ToolButton>
            )}
          </div>

          <div className="mt-3 space-y-2">
            {importPreview.isLoading && <Loader2 className="mx-auto animate-spin text-[var(--muted-foreground)]" />}
            {!importPreview.isLoading && visibleImportRows.length === 0 && (
              <p className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-center text-xs text-[var(--muted-foreground)]">
                {hiddenImportRowCount > 0 ? "All sources are hidden." : "No sources are ready to bring in."}
              </p>
            )}
            {visibleImportRows.map((sample) => (
              <ImportPreviewRowItem
                key={sample.sourceId}
                sample={sample}
                selected={selectedImportRows.has(importRowKey(importSource, sample.sourceId))}
                disabled={importSourceNotes.isPending}
                importing={activeImportIds.has(importRowKey(importSource, sample.sourceId))}
                hidden={hiddenImportRows.has(importRowKey(importSource, sample.sourceId))}
                onSelect={(selected) => setImportRowSelected(sample.sourceId, selected)}
                onImport={() => importRowsToVault([sample.sourceId])}
                onToggleHidden={() =>
                  hiddenImportRows.has(importRowKey(importSource, sample.sourceId))
                    ? unhideImportRows([sample.sourceId])
                    : hideImportRows([sample.sourceId])
                }
              />
            ))}
          </div>
        </Section>
      )}

      <Modal
        open={archiveOpen}
        onClose={() => {
          if (editingNoteId && !confirmDiscardEditor()) return;
          setArchiveOpen(false);
          setViewingDraftId(null);
          setEditingDraftId(null);
        }}
        title="Archived Memories And Suggestions"
        width="max-w-5xl"
      >
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-[var(--background)]/95 p-1">
            {(["notes", "drafts"] as const).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setArchiveTab(id)}
                className={cn(
                  "rounded-lg px-2 py-1.5 text-xs font-medium transition-all active:scale-[0.98]",
                  archiveTab === id
                    ? "bg-rose-300/15 text-[var(--foreground)] ring-1 ring-rose-300/30"
                    : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
                )}
              >
                {id === "notes" ? "Memories" : "Suggestions"}
              </button>
            ))}
          </div>

          {archiveTab === "notes" && (
            <div className="space-y-2">
              {archivedNotes.isLoading && <Loader2 className="mx-auto animate-spin text-[var(--muted-foreground)]" />}
              {!archivedNotes.isLoading && (archivedNotes.data ?? []).length === 0 && (
                <p className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-center text-xs text-[var(--muted-foreground)]">
                  No archived memories.
                </p>
              )}
              {(archivedNotes.data ?? []).map((note) => (
                <NoteRow
                  key={note.id}
                  note={note}
                  viewing={viewingNoteId === note.id}
                  editing={editingNoteId === note.id}
                  onView={() => requestViewNote(note.id)}
                  onEdit={() => requestEditNote(note.id)}
                  onRestore={() => restoreNote(note)}
                />
              ))}
            </div>
          )}

          {archiveTab === "drafts" && (
            <div className="space-y-2">
              {allDrafts.isLoading && <Loader2 className="mx-auto animate-spin text-[var(--muted-foreground)]" />}
              {!allDrafts.isLoading && archivedDrafts.length === 0 && (
                <p className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-center text-xs text-[var(--muted-foreground)]">
                  No archived suggestions.
                </p>
              )}
              {archivedDrafts.map((draft) => (
                <ArchivedDraftRow
                  key={draft.id}
                  draft={draft}
                  selected={viewingDraftId === draft.id || editingDraftId === draft.id}
                  onView={() => {
                    setEditingDraftId(null);
                    setViewingDraftId(draft.id);
                  }}
                  onEdit={() => {
                    setViewingDraftId(null);
                    setEditingDraftId(draft.id);
                  }}
                  onRestore={() => restoreDraft(draft)}
                  onDelete={() => deleteArchivedDraft(draft)}
                />
              ))}
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={creatingNote}
        onClose={() => {
          if (!confirmDiscardCreate()) return;
          closeCreateForm();
        }}
        title="New Memory"
        width="max-w-3xl"
      >
        <CreateLongTermMemoryNoteForm
          initialDraft={createNoteDraft}
          onCancel={() => {
            if (!confirmDiscardCreate()) return;
            closeCreateForm();
          }}
          onDirtyChange={setCreateNoteDirty}
          onDraftChange={setCreateNoteDraft}
          onCreated={(note) => {
            closeCreateForm();
            setEditingNoteId(note.id);
            setEditedNoteDirty(false);
          }}
        />
      </Modal>

      <Modal
        open={Boolean(viewingNote)}
        onClose={closeViewer}
        title={viewingNote ? friendlyNoteTitle(viewingNote) : "View Memory"}
        width="max-w-4xl"
      >
        {viewingNote && (
          <NoteViewModalContent
            note={viewingNote}
            drafts={allDrafts.data ?? []}
            draftsLoading={allDrafts.isLoading}
          />
        )}
      </Modal>

      <Modal
        open={Boolean(editingNote)}
        onClose={() => {
          if (!confirmDiscardEditor()) return;
          closeEditor();
        }}
        title={editingNote ? `Edit ${friendlyNoteTitle(editingNote)}` : "Edit Memory"}
        width="max-w-4xl"
      >
        {editingNote && (
          <LongTermMemoryNoteEditor
            note={editingNote}
            onCancel={closeEditor}
            onDirtyChange={setEditedNoteDirty}
            onSaved={(saved) => {
              setEditedNoteDirty(false);
              setEditingNoteId(saved.id);
            }}
          />
        )}
      </Modal>

      <Modal
        open={Boolean(viewingDraft)}
        onClose={closeDraftViewer}
        title={viewingDraft?.summary || "View Suggestion"}
        width="max-w-4xl"
      >
        {viewingDraft && <DraftDetails draft={viewingDraft} />}
      </Modal>

      <Modal
        open={Boolean(editingDraft)}
        onClose={closeDraftEditor}
        title={editingDraft ? `Edit Suggestion ${editingDraft.id}` : "Edit Suggestion"}
        width="max-w-4xl"
      >
        {editingDraft && (
          <DraftJsonEditor
            draft={editingDraft}
            onSaved={(saved) => {
              setEditingDraftId(saved.id);
            }}
          />
        )}
      </Modal>

      {(status.isLoading || integrity.isLoading) && (
        <div className="fixed bottom-3 right-3 rounded-full bg-[var(--card)] p-2 shadow-sm ring-1 ring-[var(--border)]">
          <Loader2 size="1rem" className="animate-spin" />
        </div>
      )}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--secondary)]/25 p-3 text-[0.625rem] text-[var(--muted-foreground)]">
        <div className="flex items-center gap-2">
          <DatabaseZap size="0.875rem" />
          Suggestions only appear when memory extraction is enabled for the active chat.
        </div>
        <div className="mt-1 flex items-center gap-2">
          <Sparkles size="0.875rem" />
          Kept suggestions refresh memory search automatically.
        </div>
      </div>
    </div>
  );
}
