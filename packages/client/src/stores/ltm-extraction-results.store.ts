import { create } from "zustand";
import type { ExtractLongTermMemorySourceResponse } from "../hooks/use-long-term-memory";

export type LongTermMemoryLatestExtractionResult = Pick<
  ExtractLongTermMemorySourceResponse,
  "accounting" | "diagnostics" | "operationId" | "outcome"
> & {
  mutationCount?: number;
};

interface LtmExtractionResultsState {
  resultsBySourceNoteId: Record<string, LongTermMemoryLatestExtractionResult>;
  setResult: (sourceNoteId: string, result: LongTermMemoryLatestExtractionResult | null) => void;
}

export const useLtmExtractionResultsStore = create<LtmExtractionResultsState>((set) => ({
  resultsBySourceNoteId: {},
  setResult: (sourceNoteId, result) =>
    set((state) => {
      if (result === null) {
        if (!(sourceNoteId in state.resultsBySourceNoteId)) return state;
        const next = { ...state.resultsBySourceNoteId };
        delete next[sourceNoteId];
        return { resultsBySourceNoteId: next };
      }
      return { resultsBySourceNoteId: { ...state.resultsBySourceNoteId, [sourceNoteId]: result } };
    }),
}));
