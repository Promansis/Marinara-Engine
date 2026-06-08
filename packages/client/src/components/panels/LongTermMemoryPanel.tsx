import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  DatabaseZap,
  FileJson,
  Hammer,
  History,
  Import,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type { LtmDraftStatus, LtmExtractionDraft, LtmNote, LtmNoteType, LtmStatus } from "@marinara-engine/shared";
import {
  useAcceptLongTermMemoryDraft,
  useCreateLongTermMemoryImportDrafts,
  useLongTermMemoryDrafts,
  useLongTermMemoryImportPreview,
  useLongTermMemoryIntegrity,
  useLongTermMemoryNotes,
  useLongTermMemoryStatus,
  useRebuildLongTermMemory,
  useRejectLongTermMemoryDraft,
  useRepairLongTermMemory,
  useReplayLongTermMemory,
  type LtmInteropSource,
} from "../../hooks/use-long-term-memory";
import { useChatStore } from "../../stores/chat.store";
import { useUpdateChatMetadata } from "../../hooks/use-chats";
import { cn } from "../../lib/utils";

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
const NOTE_STATUSES: Array<"all" | LtmStatus> = ["all", "active", "dormant", "resolved", "archived"];
const DRAFT_STATUSES: Array<"all" | LtmDraftStatus> = ["all", "pending", "accepted", "rejected", "auto_applied"];
const IMPORT_SOURCES: Array<{ id: LtmInteropSource; label: string }> = [
  { id: "characters", label: "Characters" },
  { id: "lorebooks", label: "Lorebooks" },
  { id: "chats", label: "Chat Summaries" },
];

type TabId = "notes" | "drafts" | "tools" | "import";

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

function StatusPill({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "good" | "warn" | "bad" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[0.7rem] font-semibold",
        tone === "good" && "border-emerald-400/40 bg-emerald-500/10 text-emerald-200",
        tone === "warn" && "border-amber-400/40 bg-amber-500/10 text-amber-200",
        tone === "bad" && "border-rose-400/40 bg-rose-500/10 text-rose-200",
        tone === "neutral" && "border-[var(--border)] bg-[var(--muted)]/40 text-[var(--muted-foreground)]",
      )}
    >
      {label}
    </span>
  );
}

function ToolButton({
  onClick,
  disabled,
  children,
  tone = "secondary",
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  tone?: "primary" | "secondary" | "danger";
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-60",
        tone === "primary" && "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-sm",
        tone === "secondary" && "border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] hover:bg-[var(--accent)]",
        tone === "danger" && "border border-rose-400/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20",
      )}
    >
      {children}
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-[var(--border)]/40 px-4 py-4 last:border-b-0">
      <h3 className="mb-3 text-sm font-semibold text-[var(--foreground)]">{title}</h3>
      {children}
    </section>
  );
}

function NoteRow({ note }: { note: LtmNote }) {
  const sectionCount = Object.keys(note.sections).length;
  return (
    <article className="rounded-lg border border-[var(--border)] bg-[var(--card)]/70 p-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[var(--foreground)]">{note.id}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <StatusPill label={note.type} />
            <StatusPill label={note.status} tone={note.status === "active" ? "good" : "neutral"} />
            <StatusPill label={`${sectionCount} sections`} />
          </div>
        </div>
      </div>
      {note.tags.length > 0 && (
        <div className="mt-2 truncate text-xs text-[var(--muted-foreground)]">Tags: {note.tags.join(", ")}</div>
      )}
    </article>
  );
}

function DraftRow({ draft }: { draft: LtmExtractionDraft }) {
  const accept = useAcceptLongTermMemoryDraft();
  const reject = useRejectLongTermMemoryDraft();
  const pending = draft.status === "pending";

  return (
    <article className="rounded-lg border border-[var(--border)] bg-[var(--card)]/70 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[var(--foreground)]">{draft.summary || draft.id}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <StatusPill label={draft.status} tone={pending ? "warn" : draft.status === "accepted" ? "good" : "neutral"} />
            <StatusPill label={`${draft.mutations.length} mutations`} />
          </div>
        </div>
      </div>
      {pending && (
        <div className="mt-3 flex flex-wrap gap-2">
          <ToolButton
            onClick={() =>
              accept
                .mutateAsync(draft.id)
                .then(() => toast.success("Draft accepted"))
                .catch((err: Error) => toast.error(err.message))
            }
            disabled={accept.isPending}
            tone="primary"
          >
            <Check size="0.875rem" />
            Accept
          </ToolButton>
          <ToolButton
            onClick={() =>
              reject
                .mutateAsync({ id: draft.id, reason: "Rejected from memory panel" })
                .then(() => toast.success("Draft rejected"))
                .catch((err: Error) => toast.error(err.message))
            }
            disabled={reject.isPending}
          >
            <X size="0.875rem" />
            Reject
          </ToolButton>
        </div>
      )}
    </article>
  );
}

function ChatMemorySettings() {
  const activeChat = useChatStore((s) => s.activeChat);
  const updateMeta = useUpdateChatMetadata();
  const metadata = parseMetadata(activeChat?.metadata);
  const enabled = metadata.enableLongTermMemory === true;
  const debug = metadata.longTermMemoryDebug === true;
  const budget = typeof metadata.longTermMemoryBudgetTokens === "number" ? metadata.longTermMemoryBudgetTokens : 2048;

  if (!activeChat) {
    return <p className="text-sm text-[var(--muted-foreground)]">Open a chat to edit its long-term memory settings.</p>;
  }

  const patch = (next: Record<string, unknown>) =>
    updateMeta
      .mutateAsync({ id: activeChat.id, ...next })
      .then(() => toast.success("Chat memory settings updated"))
      .catch((err: Error) => toast.error(err.message));

  return (
    <div className="space-y-3">
      <label className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--card)]/70 p-3">
        <span className="text-sm font-semibold text-[var(--foreground)]">Use LTM in this chat</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => patch({ enableLongTermMemory: event.target.checked })}
          className="h-4 w-4 accent-[var(--primary)]"
        />
      </label>
      <label className="block rounded-lg border border-[var(--border)] bg-[var(--card)]/70 p-3">
        <span className="text-sm font-semibold text-[var(--foreground)]">Budget tokens</span>
        <input
          type="number"
          min={128}
          max={16384}
          value={budget}
          onChange={(event) => patch({ longTermMemoryBudgetTokens: Number(event.target.value) })}
          className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"
        />
      </label>
      <label className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--card)]/70 p-3">
        <span className="text-sm font-semibold text-[var(--foreground)]">Debug events</span>
        <input
          type="checkbox"
          checked={debug}
          onChange={(event) => patch({ longTermMemoryDebug: event.target.checked })}
          className="h-4 w-4 accent-[var(--primary)]"
        />
      </label>
    </div>
  );
}

export function LongTermMemoryPanel() {
  const [tab, setTab] = useState<TabId>("notes");
  const [noteType, setNoteType] = useState<"all" | LtmNoteType>("all");
  const [noteStatus, setNoteStatus] = useState<"all" | LtmStatus>("all");
  const [draftStatus, setDraftStatus] = useState<"all" | LtmDraftStatus>("pending");
  const [query, setQuery] = useState("");
  const [importSource, setImportSource] = useState<LtmInteropSource>("characters");
  const [importLimit, setImportLimit] = useState(25);

  const status = useLongTermMemoryStatus();
  const integrity = useLongTermMemoryIntegrity();
  const notes = useLongTermMemoryNotes({
    type: noteType === "all" ? undefined : noteType,
    status: noteStatus === "all" ? undefined : noteStatus,
  });
  const drafts = useLongTermMemoryDrafts({ status: draftStatus === "all" ? undefined : draftStatus });
  const importPreview = useLongTermMemoryImportPreview(importSource, importLimit);
  const rebuild = useRebuildLongTermMemory();
  const replay = useReplayLongTermMemory();
  const repair = useRepairLongTermMemory();
  const createImports = useCreateLongTermMemoryImportDrafts();

  const filteredNotes = useMemo(() => {
    const list = notes.data ?? [];
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
  const statusTone = integrity.data?.ok ? "good" : integrity.data ? "bad" : "neutral";

  return (
    <div className="min-h-full bg-[var(--background)] text-[var(--foreground)]">
      <Section title="Overview">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)]/70 p-3">
            <div className="text-xl font-bold">{status.data?.notes.total ?? 0}</div>
            <div className="text-xs text-[var(--muted-foreground)]">Notes</div>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)]/70 p-3">
            <div className="text-xl font-bold">{status.data?.indexes.chunkCount ?? 0}</div>
            <div className="text-xs text-[var(--muted-foreground)]">Chunks</div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <StatusPill label={status.data?.directory ?? "long-term-memory"} />
          <StatusPill label={integrity.data?.ok ? "Integrity OK" : "Needs check"} tone={statusTone} />
          <StatusPill label={status.data?.indexes.embeddingsAvailable ? "Embeddings" : "Lexical fallback"} tone="neutral" />
        </div>
      </Section>

      <div className="sticky top-0 z-10 flex gap-1 border-b border-[var(--border)] bg-[var(--background)]/95 px-3 py-2 backdrop-blur-sm">
        {(["notes", "drafts", "tools", "import"] as TabId[]).map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-semibold capitalize transition-colors",
              tab === id ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "text-[var(--muted-foreground)] hover:bg-[var(--accent)]",
            )}
          >
            {id}
          </button>
        ))}
      </div>

      {tab === "notes" && (
        <Section title="Vault Notes">
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)]/70 px-3 py-2">
            <Search size="0.875rem" className="text-[var(--muted-foreground)]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search notes"
              className="min-w-0 flex-1 bg-transparent text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
            />
          </div>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <select
              value={noteType}
              onChange={(event) => setNoteType(event.target.value as "all" | LtmNoteType)}
              className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-2 text-sm"
            >
              {NOTE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <select
              value={noteStatus}
              onChange={(event) => setNoteStatus(event.target.value as "all" | LtmStatus)}
              className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-2 text-sm"
            >
              {NOTE_STATUSES.map((statusId) => (
                <option key={statusId} value={statusId}>
                  {statusId}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            {notes.isLoading && <Loader2 className="mx-auto animate-spin text-[var(--muted-foreground)]" />}
            {!notes.isLoading && filteredNotes.length === 0 && (
              <p className="rounded-lg border border-[var(--border)] bg-[var(--card)]/70 p-3 text-sm text-[var(--muted-foreground)]">
                No matching notes.
              </p>
            )}
            {filteredNotes.map((note) => (
              <NoteRow key={note.id} note={note} />
            ))}
          </div>
        </Section>
      )}

      {tab === "drafts" && (
        <Section title="Draft Review">
          <select
            value={draftStatus}
            onChange={(event) => setDraftStatus(event.target.value as "all" | LtmDraftStatus)}
            className="mb-3 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-2 text-sm"
          >
            {DRAFT_STATUSES.map((statusId) => (
              <option key={statusId} value={statusId}>
                {statusId}
              </option>
            ))}
          </select>
          <div className="space-y-2">
            {filteredDrafts.length === 0 && (
              <p className="rounded-lg border border-[var(--border)] bg-[var(--card)]/70 p-3 text-sm text-[var(--muted-foreground)]">
                No drafts in this view.
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
          <Section title="Rebuild, Replay, Repair">
            <div className="space-y-2">
              <ToolButton
                onClick={() => rebuild.mutateAsync().then(() => toast.success("Indexes rebuilt")).catch((err: Error) => toast.error(err.message))}
                disabled={rebuild.isPending}
                tone="primary"
              >
                <RefreshCw size="0.875rem" />
                Rebuild Indexes
              </ToolButton>
              <ToolButton
                onClick={() =>
                  replay
                    .mutateAsync()
                    .then((result) => toast(result.replayable ? "Replay audit passed" : result.messages[0]))
                    .catch((err: Error) => toast.error(err.message))
                }
                disabled={replay.isPending}
              >
                <History size="0.875rem" />
                Replay Audit
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
                Quarantine And Rebuild
              </ToolButton>
            </div>
            <div className="mt-3 space-y-2">
              {(integrity.data?.issues ?? []).slice(0, 8).map((issue) => (
                <div key={`${issue.code}-${issue.path ?? issue.noteId ?? issue.message}`} className="rounded-lg border border-[var(--border)] bg-[var(--card)]/70 p-3 text-sm">
                  <div className="flex items-center gap-2 font-semibold">
                    {issue.severity === "error" ? <AlertTriangle size="0.875rem" className="text-rose-300" /> : <ShieldCheck size="0.875rem" />}
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
        <Section title="Import As Drafts">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <select
              value={importSource}
              onChange={(event) => setImportSource(event.target.value as LtmInteropSource)}
              className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-2 text-sm"
            >
              {IMPORT_SOURCES.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              max={100}
              value={importLimit}
              onChange={(event) => setImportLimit(Number(event.target.value))}
              className="w-20 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-2 text-sm"
            />
          </div>
          <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--card)]/70 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-[var(--foreground)]">
                  {importPreview.data?.draftable ?? 0} draftable sources
                </div>
                <div className="text-xs text-[var(--muted-foreground)]">Imports create drafts only. Existing data is not changed.</div>
              </div>
              {importPreview.isLoading ? <Loader2 className="animate-spin" size="1rem" /> : <FileJson size="1rem" />}
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {(importPreview.data?.samples ?? []).map((sample) => (
              <div key={sample.sourceId} className="rounded-lg border border-[var(--border)] bg-[var(--card)]/70 p-3">
                <div className="truncate text-sm font-semibold">{sample.title}</div>
                <div className="mt-1 text-xs text-[var(--muted-foreground)]">{sample.summary}</div>
              </div>
            ))}
          </div>
          <div className="mt-3">
            <ToolButton
              onClick={() =>
                createImports
                  .mutateAsync({ source: importSource, limit: importLimit })
                  .then((result) => toast.success(`Created ${result.created.length} draft(s)`))
                  .catch((err: Error) => toast.error(err.message))
              }
              disabled={createImports.isPending || (importPreview.data?.draftable ?? 0) === 0}
              tone="primary"
            >
              <Import size="0.875rem" />
              Create Drafts
            </ToolButton>
          </div>
        </Section>
      )}

      {(status.isLoading || integrity.isLoading) && (
        <div className="fixed bottom-3 right-3 rounded-full border border-[var(--border)] bg-[var(--card)] p-2 shadow-sm">
          <Loader2 size="1rem" className="animate-spin" />
        </div>
      )}
      <div className="px-4 pb-4 text-xs text-[var(--muted-foreground)]">
        <div className="flex items-center gap-2">
          <DatabaseZap size="0.875rem" />
          Prompt injection stays disabled unless a chat enables it.
        </div>
        <div className="mt-1 flex items-center gap-2">
          <Sparkles size="0.875rem" />
          Accepted drafts rebuild indexes automatically.
        </div>
      </div>
    </div>
  );
}
