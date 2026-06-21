import { Import, Loader2 } from "lucide-react";
import type { Chat, LtmExtractionDraft, LtmNote } from "@marinara-engine/shared";
import { friendlyMode } from "./ltm-editor-utils";
import { cn } from "../../lib/utils";
import {
  listRowClassName,
  selectedListRowClassName,
} from "./LtmFields";
import { StatusPill } from "./LtmPills";
import { MutationPreview, SourceNoteReference } from "./LongTermMemoryNoteModal";
import {
  draftRiskSummary,
  rowActionButtonClassName,
  rowActionGroupClassName,
  mutationRiskLabel,
  mutationRiskTone,
  type ImportPreviewRow,
} from "./ltm-panel-shared";

function draftStatusTone(statusId: LtmExtractionDraft["status"]) {
  if (statusId === "pending") return "warn";
  if (statusId === "accepted" || statusId === "auto_applied") return "good";
}

function draftStatusLabel(statusId: LtmExtractionDraft["status"]) {
  if (statusId === "pending") return "Needs review";
  if (statusId === "accepted") return "Kept";
  return "Kept automatically";
}

export function DraftDetails({
  draft,
  noteLookup,
  chatLookup,
  onOpenSourceNote,
}: {
  draft: LtmExtractionDraft;
  noteLookup?: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  onOpenSourceNote?: (noteId: string) => void;
}) {
  const { highestRisk, averageConfidence, evidenceCount } = draftRiskSummary(draft);
  return (
    <div className="grid gap-4">
      <div className="space-y-3 rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
        <div className="flex flex-wrap gap-1.5">
          <StatusPill label={draftStatusLabel(draft.status)} tone={draftStatusTone(draft.status)} />
          <StatusPill label={`${draft.mutations.length} suggested change${draft.mutations.length === 1 ? "" : "s"}`} />
          {draft.modes.map((mode) => (
            <StatusPill key={mode} label={friendlyMode(mode)} />
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <StatusPill label={`Risk ${mutationRiskLabel(highestRisk)}`} tone={mutationRiskTone(highestRisk)} />
          <StatusPill label={`Confidence ${Math.round(averageConfidence * 100)}%`} />
          <StatusPill label={`${evidenceCount} reference${evidenceCount === 1 ? "" : "s"}`} />
        </div>
        {draft.source.sourceNoteId && (
          <div className="mt-2">
            <SourceNoteReference
              sourceNoteId={draft.source.sourceNoteId}
              noteLookup={noteLookup}
              chatLookup={chatLookup}
              onOpenSourceNote={onOpenSourceNote}
            />
          </div>
        )}
        <div className="text-[0.625rem] text-[var(--muted-foreground)]">
          Created {new Date(draft.createdAt).toLocaleString()} · updated {new Date(draft.updatedAt).toLocaleString()}
        </div>
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

export function ImportPreviewRowItem({
  sample,
  selected,
  disabled,
  importing,
  onSelect,
  onImport,
}: {
  sample: ImportPreviewRow;
  selected: boolean;
  disabled?: boolean;
  importing?: boolean;
  onSelect: (selected: boolean) => void;
  onImport: () => void;
}) {
  return (
    <article
      className={cn(
        "group grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3",
        listRowClassName,
        selected && selectedListRowClassName,
      )}
    >
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled}
          onChange={(event) => onSelect(event.target.checked)}
          className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
          aria-label={`Select ${sample.title}`}
        />
      <div className="min-w-0 self-center">
        <div className="truncate text-xs font-medium text-[var(--foreground)]" title={sample.title}>
          {sample.title}
        </div>
        {sample.snippet && (
          <div className="mt-1 truncate text-[10px] leading-relaxed text-[var(--muted-foreground)]" title={sample.snippet}>
            {sample.snippet}
          </div>
        )}
      </div>
      <div className={rowActionGroupClassName}>
        <button
          type="button"
          onClick={onImport}
          disabled={disabled || importing}
          className={cn(
            rowActionButtonClassName,
            "bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary)]/85",
          )}
          aria-label={`Import ${sample.title}`}
          title="Import"
        >
          {importing ? <Loader2 size="0.875rem" className="animate-spin" /> : <Import size="0.875rem" />}
        </button>
      </div>
    </article>
  );
}
