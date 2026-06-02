import type { QueryClient } from "@tanstack/react-query";

import { prefetchCharacterPanelSummaries } from "./hooks/use-characters";

export { CharactersPanel } from "./components/CharactersPanel";

export function prefetchCharactersPanelData(queryClient: QueryClient): Promise<unknown> {
  return prefetchCharacterPanelSummaries(queryClient);
}
