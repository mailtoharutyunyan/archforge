/**
 * Scanner registry.
 *
 * A repository is rarely one language. A typical system is a TypeScript
 * frontend, a Go or Java service, a Python job, a docker-compose file and some
 * Kubernetes YAML — and the architecture only makes sense when all of it is
 * read together. So scanning is a set of plugins over a shared `FileSource`,
 * and their results merge into one `ScanResult`.
 *
 * Adding support for a stack means registering a scanner here, or — for most
 * cases — adding rows to the tables in `polyglot.ts`. Nothing else changes.
 */

import { scanJava } from './java.ts';
import { scanPolyglot } from './polyglot.ts';
import type { FileSource } from './source.ts';
import { languageOf } from './source.ts';
import type { ScanResult } from './types.ts';
import { compareIds, sortBy } from '../util/canonical.ts';

export interface Scanner {
  readonly id: string;
  /** Human-readable, shown in `arch analyze` output. */
  readonly title: string;
  scan(source: FileSource, options: ScannerOptions): Promise<ScanResult>;
}

export interface ScannerOptions {
  readonly include?: readonly string[];
  readonly maxFileBytes?: number;
  /** Restrict to these scanner ids. Empty or absent means all of them. */
  readonly scanners?: readonly string[];
}

/**
 * Registration order is also merge precedence: when two scanners report the
 * same id, the earlier one's richer, language-specific result is kept and the
 * later one is dropped. The Java scanner understands Spring semantics the
 * generic table cannot, so it runs first.
 */
export const SCANNERS: readonly Scanner[] = [
  { id: 'java', title: 'Java / Kotlin / Spring', scan: (source, options) => scanJava(source, options) },
  {
    id: 'polyglot',
    title: 'JavaScript, Python, Go, .NET, Ruby, PHP, Rust, manifests, containers, IaC',
    scan: (source, options) => scanPolyglot(source, options),
  },
];

export interface RepositoryScan extends ScanResult {
  /** Which languages were actually found, sorted. */
  readonly languages: readonly string[];
  /** Which scanners contributed, sorted. */
  readonly scannersRun: readonly string[];
}

/** Runs every applicable scanner and merges the results deterministically. */
export async function scanRepository(
  source: FileSource,
  options: ScannerOptions = {},
): Promise<RepositoryScan> {
  const selected =
    options.scanners && options.scanners.length > 0
      ? SCANNERS.filter((scanner) => options.scanners?.includes(scanner.id))
      : SCANNERS;

  const results: { scanner: Scanner; result: ScanResult }[] = [];
  for (const scanner of selected) {
    results.push({ scanner, result: await scanner.scan(source, options) });
  }

  const languages = new Set<string>();
  for (const ref of await source.list()) {
    const language = languageOf(ref.path);
    if (language) languages.add(language);
  }

  return {
    ...merge(results.map((entry) => entry.result)),
    languages: [...languages].sort(compareIds),
    scannersRun: results
      .filter((entry) => hasFindings(entry.result))
      .map((entry) => entry.scanner.id)
      .sort(compareIds),
  };
}

function hasFindings(result: ScanResult): boolean {
  return (
    result.components.length > 0 ||
    result.externals.length > 0 ||
    result.relations.length > 0 ||
    result.signals.length > 0
  );
}

/**
 * Merges scan results, de-duplicating by id with first-wins precedence.
 *
 * First-wins matters: a language-aware scanner may resolve a Kafka topic name
 * from a constant, while the generic table only sees `KafkaTemplate`. Keeping
 * the first, more specific fact avoids replacing knowledge with a guess.
 */
export function merge(results: readonly ScanResult[]): ScanResult {
  const components = new Map<string, ScanResult['components'][number]>();
  const externals = new Map<string, ScanResult['externals'][number]>();
  const relations = new Map<string, ScanResult['relations'][number]>();
  const signals = new Map<string, ScanResult['signals'][number]>();
  const files = new Set<string>();
  const skipped = new Set<string>();

  for (const result of results) {
    for (const item of result.components) if (!components.has(item.id)) components.set(item.id, item);
    for (const item of result.externals) {
      const existing = externals.get(item.id);
      if (!existing) {
        externals.set(item.id, item);
        continue;
      }
      // Prefer a resolved target over an unresolved one even from a later
      // scanner: "talks to Kafka topic payment.events" beats "talks to Kafka".
      if (existing.unresolved && !item.unresolved) externals.set(item.id, item);
    }
    for (const item of result.relations) if (!relations.has(item.id)) relations.set(item.id, item);
    for (const item of result.signals) if (!signals.has(item.id)) signals.set(item.id, item);
    for (const file of result.files) files.add(file);
    for (const file of result.skippedFiles) skipped.add(file);
  }

  return {
    components: sortBy([...components.values()], (item) => item.id),
    externals: sortBy([...externals.values()], (item) => item.id),
    relations: sortBy([...relations.values()], (item) => item.id),
    signals: sortBy([...signals.values()], (item) => item.id),
    files: [...files].sort(compareIds),
    skippedFiles: [...skipped].sort(compareIds),
  };
}
