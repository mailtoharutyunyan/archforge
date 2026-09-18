/**
 * Drift detection: the declared model versus what a scanner found in the code.
 *
 * The binding rule is the load-bearing design decision. A declared element is
 * bound to code *only* through its `sourcePath`; a scanned file belongs to the
 * element with the longest `sourcePath` that prefixes it. We never bind by
 * guessing that `PaymentController` "probably is" `payments.api`. Elements
 * without a binding are reported as such, so the report is explicit about what
 * it did not look at instead of implying a clean bill of health.
 *
 * Every finding that rests on scanned code carries the detector, the
 * confidence class and the evidence lines. No numeric scores are produced.
 */

import type { ArchModel } from '../model/model.ts';
import type { Confidence, Element, Evidence, Relation, Severity } from '../model/types.ts';
import { CONFIDENCE_ORDER } from '../model/types.ts';
import type { InferredExternal, InferredRelation, ScanResult } from '../scan/types.ts';
import { compareIds, slug } from '../util/canonical.ts';

export interface DriftOptions {
  model: ArchModel;
  scan: ScanResult;
  /** Inferred facts below this class are ignored. Default `medium`. */
  minConfidence?: Confidence;
}

export type DriftKind =
  | 'undocumented-dependency'
  | 'missing-implementation'
  | 'unbound-element'
  | 'technology-mismatch';

export interface DriftFinding {
  kind: DriftKind;
  severity: Severity;
  message: string;
  elementId?: string;
  detector?: string;
  confidence?: Confidence;
  evidence: readonly Evidence[];
}

export interface DriftReport {
  findings: readonly DriftFinding[];
  boundElements: readonly string[];
  unboundElements: readonly string[];
  summary: { scannedFiles: number; declaredRelations: number; inferredRelations: number };
}

// ---------------------------------------------------------------------------
// Binding: files -> elements via sourcePath
// ---------------------------------------------------------------------------

export function normalizeSourcePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function fileUnder(file: string, sourcePath: string): boolean {
  return sourcePath === '' || file === sourcePath || file.startsWith(`${sourcePath}/`);
}

interface Binding {
  /** Owner element id per scanned file (only files that some element claims). */
  readonly ownerOf: ReadonlyMap<string, string>;
  /** Normalised sourcePath per element that has one. */
  readonly sourcePathOf: ReadonlyMap<string, string>;
  /** Elements that own at least one scanned file. */
  readonly bound: ReadonlySet<string>;
}

function bind(model: ArchModel, files: readonly string[]): Binding {
  const sourcePathOf = new Map<string, string>();
  for (const element of model.elements) {
    if (element.sourcePath !== undefined) sourcePathOf.set(element.id, normalizeSourcePath(element.sourcePath));
  }
  const candidates = [...sourcePathOf.entries()].sort((a, b) => {
    // Longest sourcePath first; ties broken by id so the result is stable.
    if (a[1].length !== b[1].length) return b[1].length - a[1].length;
    return compareIds(a[0], b[0]);
  });

  const ownerOf = new Map<string, string>();
  const bound = new Set<string>();
  for (const file of files) {
    const owner = candidates.find(([, sp]) => fileUnder(file, sp));
    if (!owner) continue;
    ownerOf.set(file, owner[0]);
    bound.add(owner[0]);
  }
  return { ownerOf, sourcePathOf, bound };
}

/** The element whose code an inferred relation lives in: deepest owner across its evidence. */
function attribute(relation: InferredRelation, binding: Binding): string | undefined {
  let best: { id: string; depth: number } | undefined;
  for (const e of relation.provenance.evidence) {
    const id = binding.ownerOf.get(e.file);
    if (!id) continue;
    const depth = binding.sourcePathOf.get(id)?.length ?? 0;
    if (!best || depth > best.depth || (depth === best.depth && compareIds(id, best.id) < 0)) {
      best = { id, depth };
    }
  }
  return best?.id;
}

// ---------------------------------------------------------------------------
// Target matching vocabulary
// ---------------------------------------------------------------------------

/**
 * Product families that contradict each other when both sides name one.
 * "HTTP" and friends are deliberately absent: declaring `HTTPS/JSON` and
 * detecting `HTTP/Feign` is not a contradiction.
 */
const TECH_FAMILIES: readonly { family: string; re: RegExp }[] = [
  { family: 'postgresql', re: /postgres/i },
  { family: 'mysql', re: /\bmysql\b/i },
  { family: 'mariadb', re: /mariadb/i },
  { family: 'oracle', re: /\boracle\b/i },
  { family: 'h2', re: /\bh2\b/i },
  { family: 'sqlserver', re: /sql\s*server|\bmssql\b/i },
  { family: 'sqlite', re: /sqlite/i },
  { family: 'db2', re: /\bdb2\b/i },
  { family: 'mongodb', re: /mongo/i },
  { family: 'redis', re: /redis|valkey/i },
  { family: 'memcached', re: /memcache/i },
  { family: 'kafka', re: /kafka/i },
  { family: 'rabbitmq', re: /rabbit|\bamqp\b/i },
];

function familiesOf(...texts: readonly (string | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const { family, re } of TECH_FAMILIES) if (re.test(text)) out.add(family);
  }
  return out;
}

const DATABASE_FAMILIES: ReadonlySet<string> = new Set(['postgresql', 'mysql', 'mariadb', 'oracle', 'h2', 'sqlserver', 'sqlite', 'db2', 'mongodb']);
const CACHE_FAMILIES: ReadonlySet<string> = new Set(['redis', 'memcached']);
const MESSAGING_FAMILIES: ReadonlySet<string> = new Set(['kafka', 'rabbitmq']);

type Category = 'database' | 'cache' | 'messaging' | 'system' | 'other';

/** What kind of thing a declared element is, from subtype first, technology second. */
export function categoryOfDeclared(element: Element): Category {
  const subtype = (element.subtype ?? '').toLowerCase();
  if (/^(database|db|datastore|rdbms|store)$/.test(subtype)) return 'database';
  if (subtype === 'cache') return 'cache';
  if (/^(topic|queue|broker|messaging|stream|event-?bus|message-?bus)$/.test(subtype)) return 'messaging';
  const families = familiesOf(element.technology);
  for (const f of families) {
    if (DATABASE_FAMILIES.has(f)) return 'database';
    if (CACHE_FAMILIES.has(f)) return 'cache';
    if (MESSAGING_FAMILIES.has(f)) return 'messaging';
  }
  if (element.kind === 'system') return 'system';
  if (/^(service|api|app|application|webapp|microservice|gateway|bff)$/.test(subtype)) return 'system';
  return 'other';
}

function categoryOfInferred(target: InferredExternal): Category {
  switch (target.subtype) {
    case 'database':
      return 'database';
    case 'cache':
      return 'cache';
    case 'topic':
    case 'broker':
      return 'messaging';
    case 'system':
    case 'proxy':
      return 'system';
    default:
      return 'other';
  }
}

/** Words that carry no identity: `Payments DB` and `payments` are the same thing. */
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  'db', 'database', 'topic', 'queue', 'cache', 'service', 'svc', 'api', 'system', 'server', 'store', 'client', 'the',
]);

function nameTokens(text: string | undefined): Set<string> {
  if (!text) return new Set();
  return new Set(slug(text).split('-').filter((t) => t !== '' && !GENERIC_TOKENS.has(t)));
}

function isSubset(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

function namesMatch(declared: Element, target: InferredExternal): boolean {
  if (target.unresolved) return false;
  const targetName = target.name.toLowerCase();
  if (hostOf(declared.url) === targetName) return true;
  if (Object.values(declared.properties).some((v) => v.toLowerCase() === targetName)) return true;

  const t = nameTokens(target.name);
  if (t.size === 0) return false;
  const candidates = [declared.name, declared.localId, declared.id.slice(declared.id.lastIndexOf('.') + 1)];
  for (const candidate of candidates) {
    const d = nameTokens(candidate);
    if (d.size === 0) continue;
    if (isSubset(d, t) || isSubset(t, d)) return true;
  }
  return false;
}

export type TargetMatch = 'match' | 'technology-mismatch' | 'none';

const MATCH_RANK: Readonly<Record<TargetMatch, number>> = { none: 0, 'technology-mismatch': 1, match: 2 };

/**
 * Does the declared destination `declared` account for the inferred `target`?
 *
 * Heuristic, in order:
 *  1. Name identity. Tokens of the declared name/localId/id-tail versus the
 *     inferred name, after dropping generic words (`db`, `service`, ...), one
 *     side a subset of the other. Also: the declared `url` host equals the
 *     inferred host, or any declared property value equals the inferred name.
 *     A name match is only trusted when the categories are compatible (or one
 *     is unknown), so a system called `payment` does not absorb the topic
 *     `payment.events`.
 *  2. Category identity (database / cache / messaging) when no name matched.
 *     This is deliberately generous: scanners often cannot name a database, and
 *     most services talk to one. For `system` targets a category-only match is
 *     accepted only when the scanner could not resolve the target at all.
 *  3. Technology families. If both sides name a product family (PostgreSQL vs
 *     MySQL, Redis vs Kafka, ...) and they disagree, a structural match becomes
 *     `technology-mismatch` instead of `match`.
 *
 * Known false negatives (drift hidden): two databases from one element where
 * only one is declared; a topic declared under a different name than the code
 * uses; singular/plural or abbreviated names (`payments` vs `pmt`).
 * Known false positives (drift reported): a declared destination named unlike
 * anything in the code and without subtype/technology, e.g. a system called
 * `Ledger` with no `technology` will not account for `http-ledger-internal`
 * unless its `url` is set; placeholder-derived names that resolve differently
 * per environment.
 */
export function matchesTarget(declared: Element, target: InferredExternal): TargetMatch {
  const declaredFamilies = familiesOf(declared.technology, declared.name, declared.subtype);
  const targetFamilies = familiesOf(target.technology, target.name);
  const disjoint =
    declaredFamilies.size > 0 && targetFamilies.size > 0 && ![...declaredFamilies].some((f) => targetFamilies.has(f));

  const dCat = categoryOfDeclared(declared);
  const tCat = categoryOfInferred(target);
  const categoriesCompatible = dCat === tCat || dCat === 'other' || tCat === 'other';

  if (categoriesCompatible && namesMatch(declared, target)) {
    return disjoint ? 'technology-mismatch' : 'match';
  }
  if (dCat !== 'other' && dCat === tCat) {
    if (dCat === 'system' && !target.unresolved) return 'none';
    return disjoint ? 'technology-mismatch' : 'match';
  }
  return 'none';
}

/**
 * Whether the scanner has any detector that could see a declared relation to
 * `dest`. We only claim "missing" for things we could have found; a relation
 * to a SaaS reached through a vendor SDK is invisible to us and stays silent.
 */
function detectable(dest: Element, relation: Relation): boolean {
  const category = categoryOfDeclared(dest);
  if (category === 'database' || category === 'cache' || category === 'messaging') return true;
  if (category === 'system') {
    return /https?|rest|feign|json|web/i.test(`${relation.technology ?? ''} ${relation.protocol ?? ''} ${dest.technology ?? ''}`);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const KIND_RANK: Readonly<Record<DriftKind, number>> = {
  'undocumented-dependency': 0,
  'technology-mismatch': 1,
  'missing-implementation': 2,
  'unbound-element': 3,
};

function severityFor(confidence: Confidence): Severity {
  return confidence === 'high' ? 'error' : confidence === 'medium' ? 'warning' : 'info';
}

function compareFindings(a: DriftFinding, b: DriftFinding): number {
  if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
  const byElement = compareIds(a.elementId ?? '', b.elementId ?? '');
  if (byElement !== 0) return byElement;
  const byDetector = compareIds(a.detector ?? '', b.detector ?? '');
  if (byDetector !== 0) return byDetector;
  return compareIds(a.message, b.message);
}

function describeTarget(target: InferredExternal): string {
  return target.technology && target.technology !== target.name ? `${target.name} (${target.technology})` : target.name;
}

export function detectDrift(options: DriftOptions): DriftReport {
  const { model, scan } = options;
  const minConfidence = options.minConfidence ?? 'medium';
  const threshold = CONFIDENCE_ORDER[minConfidence];

  const relations = scan.relations.filter((r) => CONFIDENCE_ORDER[r.provenance.confidence] >= threshold);
  const externals = new Map<string, InferredExternal>();
  for (const e of scan.externals) externals.set(e.id, e);

  const binding = bind(model, scan.files);
  const findings: DriftFinding[] = [];
  const supportedDeclared = new Set<string>();
  const reportedMismatch = new Set<string>();

  /** The element, its ancestors and descendants: any of them may hold the declaration. */
  const familyOf = (id: string): Set<string> =>
    new Set([id, ...model.ancestors(id).map((e) => e.id), ...model.descendants(id).map((e) => e.id)]);

  const byOwner = new Map<string, InferredRelation[]>();
  for (const relation of relations) {
    const owner = attribute(relation, binding);
    if (!owner) continue;
    const list = byOwner.get(owner) ?? [];
    list.push(relation);
    byOwner.set(owner, list);
  }

  for (const ownerId of [...byOwner.keys()].sort(compareIds)) {
    const owner = model.element(ownerId);
    const inferred = byOwner.get(ownerId);
    if (!owner || !inferred) continue;
    const family = familyOf(ownerId);
    // Declared relations touching the family in either direction. Consumption
    // of a topic is often written as `worker -> topic "consumes"`, so we cannot
    // insist on the direction the scanner saw.
    const declared = model.relations.filter((r) => family.has(r.sourceId) || family.has(r.destId));

    for (const relation of inferred) {
      const targetId = relation.direction === 'outbound' ? relation.destId : relation.sourceId;
      const target: InferredExternal = externals.get(targetId) ?? {
        id: targetId,
        name: targetId,
        subtype: 'system',
        provenance: relation.provenance,
      };

      let best: TargetMatch = 'none';
      const matched: Relation[] = [];
      const mismatched: { relation: Relation; other: Element }[] = [];
      for (const r of declared) {
        const otherId = family.has(r.sourceId) ? r.destId : r.sourceId;
        const other = model.element(otherId);
        if (!other) continue;
        const verdict = matchesTarget(other, target);
        if (MATCH_RANK[verdict] > MATCH_RANK[best]) best = verdict;
        if (verdict === 'match') matched.push(r);
        else if (verdict === 'technology-mismatch') mismatched.push({ relation: r, other });
      }

      if (best === 'match') {
        for (const r of matched) supportedDeclared.add(r.id);
        continue;
      }
      if (best === 'technology-mismatch') {
        for (const { relation: r, other } of mismatched) {
          supportedDeclared.add(r.id);
          const key = `${ownerId}|${r.id}|${target.id}`;
          if (reportedMismatch.has(key)) continue;
          reportedMismatch.add(key);
          findings.push({
            kind: 'technology-mismatch',
            severity: 'warning',
            message:
              `${owner.name} is declared to use ${other.name}` +
              `${other.technology ? ` (${other.technology})` : ''}` +
              `, but the code talks to ${describeTarget(target)}`,
            elementId: ownerId,
            detector: relation.provenance.detector,
            confidence: relation.provenance.confidence,
            evidence: relation.provenance.evidence,
          });
        }
        continue;
      }

      const verb = relation.direction === 'outbound' ? 'depends on' : 'consumes from';
      findings.push({
        kind: 'undocumented-dependency',
        severity: severityFor(relation.provenance.confidence),
        message: `${owner.name} ${verb} ${describeTarget(target)} (${relation.provenance.detector}), but no declared relation accounts for it`,
        elementId: ownerId,
        detector: relation.provenance.detector,
        confidence: relation.provenance.confidence,
        evidence: relation.provenance.evidence,
      });
    }
  }

  // Declared but not observed. Only for relations the scanner could have seen.
  for (const r of [...model.relations].sort((a, b) => compareIds(a.id, b.id))) {
    if (!binding.bound.has(r.sourceId)) continue;
    if (supportedDeclared.has(r.id)) continue;
    const source = model.element(r.sourceId);
    const dest = model.element(r.destId);
    if (!source || !dest) continue;
    // Both ends bound to code means an internal call; this scanner does not
    // trace injection graphs, so silence is honest here.
    if (binding.bound.has(r.destId)) continue;
    if (!detectable(dest, r)) continue;
    const sourcePath = binding.sourcePathOf.get(r.sourceId) ?? '';
    findings.push({
      kind: 'missing-implementation',
      severity: 'warning',
      message:
        `${source.name} is declared to depend on ${dest.name}` +
        `${dest.technology ? ` (${dest.technology})` : ''}` +
        `, but nothing under ${sourcePath || '.'} supports it (checked at confidence >= ${minConfidence})`,
      elementId: r.sourceId,
      evidence: [],
    });
  }

  // Coverage: what this report could not assess.
  const unbound: string[] = [];
  for (const element of [...model.elements].sort((a, b) => compareIds(a.id, b.id))) {
    if (element.kind !== 'container' && element.kind !== 'component') continue;
    if (binding.bound.has(element.id)) continue;
    const category = categoryOfDeclared(element);
    // Databases, caches and topics have no code of their own to bind.
    if (category === 'database' || category === 'cache' || category === 'messaging') continue;
    unbound.push(element.id);
    const sourcePath = binding.sourcePathOf.get(element.id);
    if (sourcePath === undefined) {
      findings.push({
        kind: 'unbound-element',
        severity: 'info',
        message: `${element.name} has no sourcePath, so drift cannot be assessed for it`,
        elementId: element.id,
        evidence: [],
      });
    } else {
      findings.push({
        kind: 'unbound-element',
        severity: 'warning',
        message: `${element.name} declares sourcePath ${sourcePath} but no scanned file lives under it`,
        elementId: element.id,
        evidence: [],
      });
    }
  }

  return {
    findings: findings.sort(compareFindings),
    boundElements: [...binding.bound].sort(compareIds),
    unboundElements: unbound,
    summary: {
      scannedFiles: scan.files.length,
      declaredRelations: model.relations.length,
      inferredRelations: relations.length,
    },
  };
}
