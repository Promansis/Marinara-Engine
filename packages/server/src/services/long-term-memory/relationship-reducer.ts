import type { LtmEvidenceUnit } from "@marinara-engine/shared";

export type LtmRelationshipFacet = "low" | "medium" | "medium_high" | "high";

export interface LtmRelationshipReduction {
  facets: {
    trust: LtmRelationshipFacet;
    intimacy: LtmRelationshipFacet;
    tension: LtmRelationshipFacet;
    hostility: LtmRelationshipFacet;
    dependency: LtmRelationshipFacet;
    affection: LtmRelationshipFacet;
    protectiveness: LtmRelationshipFacet;
  };
  trajectory: string;
  supportingEvents: string[];
}

type LtmRelationshipFacetName = keyof LtmRelationshipReduction["facets"];

const FACET_WORDS: Record<LtmRelationshipFacetName, RegExp> = {
  trust: /\b(trust|honest|rely|confide|safe|faith)\b/i,
  intimacy: /\b(intimate|close|kiss|tender|vulnerable|confession)\b/i,
  tension: /\b(tension|uneasy|strain|awkward|conflict|argue)\b/i,
  hostility: /\b(hostile|enemy|threat|attack|hate|betray)\b/i,
  dependency: /\b(depend|need|rely|anchor|lifeline)\b/i,
  affection: /\b(affection|fond|care|love|warm|gentle)\b/i,
  protectiveness: /\b(protects?|protected|protecting|guards?|guarded|shield(?:s|ed|ing)?|defends?|defended|watch(?:es|ed|ing)? over)\b/i,
};

export function reduceRelationshipEvidenceUnits(units: LtmEvidenceUnit[]): LtmRelationshipReduction {
  const relationshipUnits = units
    .filter((unit) => unit.bucket === "relationship_event" || unit.bucket === "relationship_state" || unit.bucket === "relationship_arc")
    .sort((a, b) => a.sectionKey.localeCompare(b.sectionKey) || a.id.localeCompare(b.id));
  const scores: Record<LtmRelationshipFacetName, number> = {
    trust: 0,
    intimacy: 0,
    tension: 0,
    hostility: 0,
    dependency: 0,
    affection: 0,
    protectiveness: 0,
  };

  for (const unit of relationshipUnits) {
    for (const [facet, pattern] of Object.entries(FACET_WORDS)) {
      if (pattern.test(unit.text)) {
        scores[facet as LtmRelationshipFacetName] += unit.salience * unit.confidence;
      }
    }
  }

  return {
    facets: {
      trust: qualitative(scores.trust),
      intimacy: qualitative(scores.intimacy),
      tension: qualitative(scores.tension),
      hostility: qualitative(scores.hostility),
      dependency: qualitative(scores.dependency),
      affection: qualitative(scores.affection),
      protectiveness: qualitative(scores.protectiveness),
    },
    trajectory: trajectoryFor(scores),
    supportingEvents: relationshipUnits
      .filter((unit) => unit.bucket === "relationship_event")
      .map((unit) => `${unit.sectionKey}:${unit.evidence[0]}`)
      .slice(-8),
  };
}

export function formatRelationshipReduction(reduction: LtmRelationshipReduction) {
  const facets = Object.entries(reduction.facets)
    .map(([key, value]) => `${key}: ${value}`)
    .join("; ");
  const support = reduction.supportingEvents.length ? ` Supporting events: ${reduction.supportingEvents.join(", ")}.` : "";
  return `Current relationship state: ${facets}. Trajectory: ${reduction.trajectory}.${support}`;
}

function qualitative(score: number): LtmRelationshipFacet {
  if (score >= 1.8) return "high";
  if (score >= 1.1) return "medium_high";
  if (score >= 0.35) return "medium";
  return "low";
}

function trajectoryFor(scores: Record<LtmRelationshipFacetName, number>) {
  if (scores.trust + scores.affection > scores.tension + scores.hostility + 0.6) {
    return "warming_trust_with_remaining_secrets";
  }
  if (scores.tension + scores.hostility > scores.trust + scores.affection + 0.6) {
    return "strained_with_unresolved_conflict";
  }
  if (scores.protectiveness + scores.dependency > 0.8) return "protective_dependency_under_watch";
  return "mixed_stable_with_open_threads";
}
