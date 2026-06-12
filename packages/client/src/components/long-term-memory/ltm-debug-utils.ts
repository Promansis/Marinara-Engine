export function labelLtmLane(value: string) {
  switch (value) {
    case "always":
      return "Always included by policy";
    case "metadata":
      return "Matched tags, scope, or note IDs";
    case "typed_priority":
      return "Important memory type";
    case "vector":
      return "Meaning matched current context";
    case "bm25":
      return "Words matched current context";
    case "graph":
      return "Connected to another matched memory";
    default:
      return value
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  }
}

export function summarizeLtmCandidateSignals(lanes: string[], reasons: string[]) {
  const signals: string[] = [];
  const reasonText = reasons.join(" ");

  if (lanes.includes("always")) signals.push("policy include");

  if (lanes.includes("metadata")) {
    signals.push(/(?:^|\s|,)chat:|(?:^|\s|,)group:/.test(reasonText) ? "active chat/group scope" : "metadata match");
  }

  if (lanes.includes("typed_priority")) {
    signals.push(reasonText.includes("priority:current_scene") ? "current scene priority" : "memory type priority");
  }

  const contextSignals = [
    lanes.includes("vector") ? "meaning" : null,
    lanes.includes("bm25") ? "words" : null,
    lanes.includes("graph") ? "linked memory" : null,
  ].filter((item): item is string => Boolean(item));

  if (contextSignals.length > 0) signals.push(`context match (${contextSignals.join(", ")})`);

  return [...new Set(signals)].join(", ");
}

export function labelLtmTier(value: number | string | undefined) {
  const tier = typeof value === "string" ? Number.parseInt(value, 10) : value;
  switch (tier) {
    case 1:
      return "Core context";
    case 2:
      return "Active thread/callback";
    case 3:
      return "Supporting detail";
    default:
      return value ? `Tier ${value}` : "Unsorted";
  }
}

export function labelRejectionReason(value: string | undefined) {
  switch (value) {
    case "budget":
      return "Skipped by token budget";
    case "lower_rank":
      return "Below selected cutoff";
    case "missing_chunk":
      return "Chunk missing from index";
    case "filtered":
      return "Filtered before ranking";
    default:
      return value
        ? value
            .split("_")
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(" ")
        : "Not selected";
  }
}
