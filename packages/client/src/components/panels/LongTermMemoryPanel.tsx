import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { useChat, useUpdateChatMetadata } from "../../hooks/use-chats";
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
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[0.625rem] font-medium leading-tight",
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

function SettingField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[0.6875rem] font-medium text-[var(--muted-foreground)]">{label}</span>
      {children}
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
        "inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-50",
        tone === "primary" && "bg-[var(--primary)] text-white hover:opacity-90",
        tone === "secondary" &&
          "bg-[var(--secondary)] text-[var(--foreground)] ring-1 ring-[var(--border)] hover:bg-[var(--accent)]",
        tone === "danger" &&
          "bg-[var(--destructive)]/10 text-[var(--destructive)] ring-1 ring-[var(--destructive)]/25 hover:bg-[var(--destructive)]/15",
      )}
    >
      {children}
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-[var(--border)]/35 px-3 py-3 last:border-b-0">
      <h3 className="mb-2.5 text-xs font-medium text-[var(--foreground)]">{title}</h3>
      {children}
    </section>
  );
}

function NoteRow({ note }: { note: LtmNote }) {
  const sectionCount = Object.keys(note.sections).length;
  return (
    <article className="rounded-lg bg-[var(--secondary)]/50 p-3 ring-1 ring-[var(--border)]">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-[var(--foreground)]">{note.id}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <StatusPill label={note.type} />
            <StatusPill label={note.status} tone={note.status === "active" ? "good" : "neutral"} />
            <StatusPill label={`${sectionCount} sections`} />
          </div>
        </div>
      </div>
      {note.tags.length > 0 && (
        <div className="mt-2 truncate text-[0.625rem] text-[var(--muted-foreground)]">Tags: {note.tags.join(", ")}</div>
      )}
    </article>
  );
}

function DraftRow({ draft }: { draft: LtmExtractionDraft }) {
  const accept = useAcceptLongTermMemoryDraft();
  const reject = useRejectLongTermMemoryDraft();
  const pending = draft.status === "pending";

  return (
    <article className="rounded-lg bg-[var(--secondary)]/50 p-3 ring-1 ring-[var(--border)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-[var(--foreground)]">{draft.summary || draft.id}</div>
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
    <div className="space-y-3">
      <SettingToggle label="Use memory in prompts" checked={enabled} onChange={(checked) => patch({ enableLongTermMemory: checked })} />

      <div className="grid gap-3 rounded-xl bg-[var(--secondary)]/50 p-3 ring-1 ring-[var(--border)]">
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
          <SettingField label="RP scope">
            <input
              value={scopeDraft.rpId}
              onChange={(event) => setScopeDraft((current) => ({ ...current, rpId: event.target.value }))}
              onBlur={() => commitScope()}
              placeholder="main_story"
              className="w-full rounded-lg bg-[var(--background)] px-3 py-2 text-xs text-[var(--foreground)] outline-none ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:ring-[var(--primary)]"
            />
          </SettingField>
        </div>

        <SettingField label="Token budget">
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

      <SettingToggle label="Debug retrieval logs" checked={debug} onChange={(checked) => patch({ longTermMemoryDebug: checked })} />
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
          <div className="rounded-lg bg-[var(--secondary)]/50 p-3 ring-1 ring-[var(--border)]">
            <div className="text-lg font-semibold tabular-nums">{status.data?.notes.total ?? 0}</div>
            <div className="text-[0.625rem] text-[var(--muted-foreground)]">Notes</div>
          </div>
          <div className="rounded-lg bg-[var(--secondary)]/50 p-3 ring-1 ring-[var(--border)]">
            <div className="text-lg font-semibold tabular-nums">{status.data?.indexes.chunkCount ?? 0}</div>
            <div className="text-[0.625rem] text-[var(--muted-foreground)]">Chunks</div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <StatusPill label={status.data?.directory ?? "long-term-memory"} />
          <StatusPill label={integrity.data?.ok ? "Integrity OK" : "Needs check"} tone={statusTone} />
          <StatusPill label={status.data?.indexes.embeddingsAvailable ? "Embeddings" : "Lexical fallback"} tone="neutral" />
        </div>
      </Section>

      <div className="sticky top-0 z-10 grid grid-cols-4 gap-1 border-b border-[var(--border)]/35 bg-[var(--background)]/95 px-3 py-2 backdrop-blur-sm">
        {(["notes", "drafts", "tools", "import"] as TabId[]).map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "min-w-0 rounded-lg px-2 py-2 text-xs font-medium capitalize transition-all active:scale-[0.98]",
              tab === id
                ? "bg-[var(--accent)] text-[var(--foreground)] ring-1 ring-[var(--primary)]/35"
                : "bg-[var(--card)] text-[var(--muted-foreground)] ring-1 ring-[var(--border)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
            )}
          >
            {id}
          </button>
        ))}
      </div>

      {tab === "notes" && (
        <Section title="Vault Notes">
          <div className="mb-3 flex items-center gap-2 rounded-lg bg-[var(--secondary)] px-3 py-2 ring-1 ring-transparent transition-shadow focus-within:ring-[var(--primary)]">
            <Search size="0.875rem" className="text-[var(--muted-foreground)]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search notes"
              className="min-w-0 flex-1 bg-transparent text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
            />
          </div>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <select
              value={noteType}
              onChange={(event) => setNoteType(event.target.value as "all" | LtmNoteType)}
              className="rounded-lg bg-[var(--secondary)] px-2.5 py-2 text-xs outline-none ring-1 ring-transparent focus:ring-[var(--primary)]"
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
              className="rounded-lg bg-[var(--secondary)] px-2.5 py-2 text-xs outline-none ring-1 ring-transparent focus:ring-[var(--primary)]"
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
              <p className="rounded-lg bg-[var(--secondary)]/50 p-3 text-xs text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
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
            className="mb-3 w-full rounded-lg bg-[var(--secondary)] px-2.5 py-2 text-xs outline-none ring-1 ring-transparent focus:ring-[var(--primary)]"
          >
            {DRAFT_STATUSES.map((statusId) => (
              <option key={statusId} value={statusId}>
                {statusId}
              </option>
            ))}
          </select>
          <div className="space-y-2">
            {filteredDrafts.length === 0 && (
              <p className="rounded-lg bg-[var(--secondary)]/50 p-3 text-xs text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
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
                <div
                  key={`${issue.code}-${issue.path ?? issue.noteId ?? issue.message}`}
                  className="rounded-lg bg-[var(--secondary)]/50 p-3 text-xs ring-1 ring-[var(--border)]"
                >
                  <div className="flex items-center gap-2 font-medium">
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
              className="rounded-lg bg-[var(--secondary)] px-2.5 py-2 text-xs outline-none ring-1 ring-transparent focus:ring-[var(--primary)]"
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
              className="w-20 rounded-lg bg-[var(--secondary)] px-2.5 py-2 text-xs outline-none ring-1 ring-transparent focus:ring-[var(--primary)]"
            />
          </div>
          <div className="mt-3 rounded-lg bg-[var(--secondary)]/50 p-3 ring-1 ring-[var(--border)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-medium text-[var(--foreground)]">
                  {importPreview.data?.draftable ?? 0} draftable sources
                </div>
                <div className="mt-1 text-[0.625rem] text-[var(--muted-foreground)]">Imports create drafts only. Existing data is not changed.</div>
              </div>
              {importPreview.isLoading ? <Loader2 className="animate-spin" size="1rem" /> : <FileJson size="1rem" />}
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {(importPreview.data?.samples ?? []).map((sample) => (
              <div key={sample.sourceId} className="rounded-lg bg-[var(--secondary)]/50 p-3 ring-1 ring-[var(--border)]">
                <div className="truncate text-xs font-medium">{sample.title}</div>
                <div className="mt-1 text-[0.625rem] text-[var(--muted-foreground)]">{sample.summary}</div>
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
        <div className="fixed bottom-3 right-3 rounded-full bg-[var(--card)] p-2 shadow-sm ring-1 ring-[var(--border)]">
          <Loader2 size="1rem" className="animate-spin" />
        </div>
      )}
      <div className="px-3 pb-4 text-[0.625rem] text-[var(--muted-foreground)]">
        <div className="flex items-center gap-2">
          <DatabaseZap size="0.875rem" />
          Draft extraction only runs when enabled for the active chat.
        </div>
        <div className="mt-1 flex items-center gap-2">
          <Sparkles size="0.875rem" />
          Accepted drafts rebuild indexes automatically.
        </div>
      </div>
    </div>
  );
}
