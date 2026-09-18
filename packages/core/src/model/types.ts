/**
 * The architecture model. This is the source of truth; every view, render,
 * report and diff in the system is a projection of these types.
 *
 * Two invariants hold everywhere:
 *   1. `id` is stable across versions, so two models can be diffed.
 *   2. Nothing here knows about pixels, colours or HTTP.
 */

/** Position in a source file, 1-based, for diagnostics that a human can act on. */
export interface SourceLoc {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/**
 * A concrete observation in a repository that justifies an inferred fact.
 * Inference without evidence is a guess, and we do not ship guesses.
 */
export interface Evidence {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

/**
 * How much to trust a detector, expressed as a class rather than a fabricated
 * float. `high` = the code cannot mean anything else (an annotation, a typed
 * client). `medium` = a strong idiom. `low` = a textual hint.
 */
export type Confidence = 'high' | 'medium' | 'low';

export const CONFIDENCE_ORDER: Readonly<Record<Confidence, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

/**
 * Where a fact came from. Declared facts are what humans committed; inferred
 * facts are what a scanner concluded. The two are never silently merged.
 */
export type Provenance =
  | { readonly source: 'declared'; readonly loc?: SourceLoc }
  | {
      readonly source: 'inferred';
      readonly detector: string;
      readonly confidence: Confidence;
      readonly evidence: readonly Evidence[];
    };

/**
 * The closed set of structural kinds. Deliberately small: `database`, `queue`,
 * `topic` and friends are *subtypes* of a container, not new kinds, so view
 * derivation stays one code path instead of fifteen.
 */
export type ElementKind =
  | 'person'
  | 'system'
  | 'container'
  | 'component'
  | 'deploymentNode'
  | 'infrastructureNode';

export const ELEMENT_KINDS: readonly ElementKind[] = [
  'person',
  'system',
  'container',
  'component',
  'deploymentNode',
  'infrastructureNode',
];

/** Open taxonomy layered on top of `kind`, used for styling and for rules. */
export type Subtype = string;

export interface Element {
  /** Fully-qualified stable identifier, e.g. `payments.api.controller`. */
  readonly id: string;
  /** Identifier as written in the source, e.g. `controller`. */
  readonly localId: string;
  readonly kind: ElementKind;
  readonly subtype?: Subtype;
  readonly name: string;
  readonly description?: string;
  readonly technology?: string;
  readonly owner?: string;
  readonly url?: string;
  /** Sorted and de-duplicated, so canonical output is stable. */
  readonly tags: readonly string[];
  readonly properties: Readonly<Record<string, string>>;
  readonly parentId?: string;
  /**
   * Repository path this element is implemented by. This binding is what makes
   * drift detection possible without guessing at names.
   */
  readonly sourcePath?: string;
  /** For deployment nodes: the container this node runs an instance of. */
  readonly instanceOf?: string;
  readonly provenance: Provenance;
}

export type RelationDirection = 'uni' | 'bi';

export interface Relation {
  /**
   * Derived from the endpoints plus a discriminator, so a relationship keeps
   * its identity across edits and can be diffed.
   */
  readonly id: string;
  readonly sourceId: string;
  readonly destId: string;
  readonly description?: string;
  readonly technology?: string;
  readonly protocol?: string;
  readonly direction: RelationDirection;
  readonly tags: readonly string[];
  readonly properties: Readonly<Record<string, string>>;
  readonly provenance: Provenance;
}

export type ViewKind = 'context' | 'container' | 'component' | 'deployment' | 'dynamic';

export interface DynamicStep {
  readonly order: number;
  readonly sourceId: string;
  readonly destId: string;
  readonly description?: string;
  readonly technology?: string;
}

export interface ViewDef {
  readonly id: string;
  readonly kind: ViewKind;
  readonly title: string;
  /** The system (container/component views) or environment (deployment) in focus. */
  readonly scopeId?: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly steps: readonly DynamicStep[];
  readonly loc?: SourceLoc;
}

export type Severity = 'error' | 'warning' | 'info';

export const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  info: 0,
  warning: 1,
  error: 2,
};

/** A single machine-checkable claim inside a rule. */
export type Assertion =
  | { readonly type: 'forbidDependency'; readonly from: string; readonly to: string }
  | { readonly type: 'allowDependency'; readonly from: string; readonly to: string }
  | { readonly type: 'requireField'; readonly field: RequirableField; readonly on: string }
  | { readonly type: 'forbidCycles'; readonly within?: string }
  | { readonly type: 'forbidOrphans'; readonly within?: string };

export type RequirableField = 'description' | 'technology' | 'owner' | 'source';

export interface RuleDef {
  readonly id: string;
  readonly title?: string;
  readonly severity: Severity;
  readonly assertions: readonly Assertion[];
  readonly loc?: SourceLoc;
}

export interface Workspace {
  readonly name: string;
  readonly description?: string;
  readonly elements: readonly Element[];
  readonly relations: readonly Relation[];
  readonly views: readonly ViewDef[];
  readonly rules: readonly RuleDef[];
  readonly properties: Readonly<Record<string, string>>;
}

export const EMPTY_WORKSPACE: Workspace = {
  name: 'Unnamed workspace',
  elements: [],
  relations: [],
  views: [],
  rules: [],
  properties: {},
};
