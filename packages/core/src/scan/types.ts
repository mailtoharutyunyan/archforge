/**
 * Facts inferred from a repository by a scanner.
 *
 * These are deliberately *not* `Element`/`Relation`: inferred facts carry
 * evidence and a confidence class, and they are never silently merged into the
 * declared model. Drift detection compares the two; a user may later promote an
 * inferred fact to a declared one, but that is an explicit act.
 *
 * Every path in here is repo-root-relative and POSIX-style, and every id is
 * derived from names found in the code, so two scans of the same tree on two
 * machines produce byte-identical output.
 */

import type { Confidence, Evidence, Provenance } from '../model/types.ts';

/** The `inferred` arm of `Provenance`; every scanned fact carries one. */
export type InferredProvenance = Extract<Provenance, { source: 'inferred' }>;

/**
 * What an external dependency looks like from the code's side. Mirrors the
 * open `Subtype` taxonomy on `Element` so drift can compare the two directly.
 */
export type ExternalSubtype =
  | 'database'
  | 'cache'
  | 'topic'
  | 'broker'
  | 'system'
  | 'proxy'
  | 'infrastructure';

/** A class the scanner believes is an architectural building block. */
export interface InferredComponent {
  /** Stable, derived from the class name: `PaymentController` -> `payment-controller`. */
  readonly id: string;
  readonly name: string;
  readonly subtype: string;
  /** Repo-relative POSIX path of the file that declares it. */
  readonly sourcePath: string;
  /** Repo-relative POSIX path of the enclosing build module (`''` for the root). */
  readonly module: string;
  readonly technology?: string;
  readonly provenance: InferredProvenance;
}

/** Something outside the scanned code that the code talks to. */
export interface InferredExternal {
  /** Stable, derived from the target's name: `payment.events` -> `topic-payment-events`. */
  readonly id: string;
  readonly name: string;
  readonly subtype: ExternalSubtype;
  /** Engine or product where known, e.g. `PostgreSQL`, `Kafka`, `Redis`, `HTTP/Feign`. */
  readonly technology?: string;
  /** True when the detector saw the client but could not name the target. */
  readonly unresolved?: boolean;
  readonly provenance: InferredProvenance;
}

/**
 * `outbound`: the scanned code calls the target. `inbound`: the target pushes
 * into the scanned code (a topic a listener consumes). Both are stated from the
 * code's point of view so drift can reason about "what this element touches".
 */
export type InferredDirection = 'outbound' | 'inbound';

export interface InferredRelation {
  readonly id: string;
  readonly sourceId: string;
  readonly destId: string;
  readonly direction: InferredDirection;
  readonly technology?: string;
  readonly description?: string;
  readonly provenance: InferredProvenance;
}

/**
 * A fact that is neither a component nor a dependency but still tells the
 * reader something about the code, e.g. "this module has JPA entities".
 */
export interface InferredSignal {
  readonly id: string;
  readonly kind: 'persistence';
  readonly name: string;
  readonly module: string;
  readonly technology?: string;
  readonly provenance: InferredProvenance;
}

export interface ScanResult {
  readonly components: readonly InferredComponent[];
  readonly externals: readonly InferredExternal[];
  readonly relations: readonly InferredRelation[];
  readonly signals: readonly InferredSignal[];
  /** Every file that was read, repo-relative, sorted. Drift uses this to bind elements. */
  readonly files: readonly string[];
  /** Files skipped for exceeding `maxFileBytes`. */
  readonly skippedFiles: readonly string[];
}

export interface DetectorInfo {
  readonly id: string;
  readonly confidence: Confidence;
  readonly description: string;
}

/** Re-exported so scanner consumers do not have to reach into the model package. */
export type { Confidence, Evidence };
