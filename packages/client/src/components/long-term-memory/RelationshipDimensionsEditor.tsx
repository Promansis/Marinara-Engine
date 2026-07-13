import {
  DEFAULT_RELATIONSHIP_BASELINE,
  RELATIONSHIP_DIMENSIONS,
  type LtmRelationshipDimensionChanges,
  type LtmRelationshipDimensions,
} from "@marinara-engine/shared";
import {
  compactInputClassName,
  helperTextClassName,
  insetSectionCardClassName,
  microLabelClassName,
} from "./LtmFields";
import { friendlyIdentifier } from "./ltm-editor-utils";

function clampDimension(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function clampDelta(value: number) {
  return Math.max(-100, Math.min(100, Math.round(value)));
}

export function RelationshipDimensionsEditor({
  dimensions,
  dimensionChanges,
  onDimensionsChange,
  onDimensionChangesChange,
}: {
  dimensions?: LtmRelationshipDimensions;
  dimensionChanges?: LtmRelationshipDimensionChanges;
  onDimensionsChange: (dimensions: LtmRelationshipDimensions | undefined) => void;
  onDimensionChangesChange: (changes: LtmRelationshipDimensionChanges | undefined) => void;
}) {
  const updateDimension = (key: keyof LtmRelationshipDimensions, value: number) => {
    onDimensionsChange({ ...(dimensions ?? {}), [key]: clampDimension(value) });
  };
  const clearDimension = (key: keyof LtmRelationshipDimensions) => {
    const next = { ...(dimensions ?? {}) };
    delete next[key];
    onDimensionsChange(Object.keys(next).length ? next : undefined);
  };
  const updateDelta = (key: keyof LtmRelationshipDimensions, value: number) => {
    onDimensionChangesChange({ ...(dimensionChanges ?? {}), [key]: clampDelta(value) });
  };

  return (
    <div className={insetSectionCardClassName}>
      <div className="mb-3">
        <div className={microLabelClassName}>Relationship Dimensions</div>
        <p className={helperTextClassName}>
          50 is neutral baseline; deltas describe how this memory changed the relationship.
        </p>
      </div>
      <div className="divide-y divide-[var(--border)]/70">
        {RELATIONSHIP_DIMENSIONS.map((dimension) => {
          const value = dimensions?.[dimension] ?? DEFAULT_RELATIONSHIP_BASELINE;
          const delta = dimensionChanges?.[dimension] ?? 0;
          return (
            <div key={dimension} className="grid gap-2 py-3 first:pt-0 last:pb-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-[var(--foreground)]">{friendlyIdentifier(dimension)}</span>
                <button
                  type="button"
                  onClick={() => clearDimension(dimension)}
                  className="mari-chrome-control mari-chrome-control--small text-[0.6875rem]"
                >
                  Baseline
                </button>
              </div>
              <div className="grid gap-2 sm:grid-cols-[1fr_4.5rem_5rem]">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={value}
                  onChange={(event) => updateDimension(dimension, Number(event.target.value))}
                  aria-label={`${friendlyIdentifier(dimension)} score`}
                />
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={value}
                  onChange={(event) => updateDimension(dimension, Number(event.target.value))}
                  className={compactInputClassName}
                  aria-label={`${friendlyIdentifier(dimension)} value`}
                />
                <input
                  type="number"
                  min={-100}
                  max={100}
                  step={1}
                  value={delta}
                  onChange={(event) => updateDelta(dimension, Number(event.target.value))}
                  className={compactInputClassName}
                  aria-label={`${friendlyIdentifier(dimension)} change`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
