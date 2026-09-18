/**
 * Canonical serialisation.
 *
 * Every artefact this tool writes has to be byte-stable across runs, machines
 * and unrelated edits, otherwise "architecture in a pull request" degenerates
 * into unreviewable churn. That means: keys sorted, arrays ordered by an
 * explicit key, no timestamps, no host paths, no `Math.random`.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Drops `undefined` members and sorts object keys, recursively. */
export function canonicalize(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const out: { [k: string]: Json } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  return null;
}

/** Deterministic JSON with a trailing newline, suitable for committing. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

/** Sorted, de-duplicated string list. Used for tags so diffs stay minimal. */
export function normalizeTags(tags: Iterable<string>): string[] {
  return [...new Set([...tags].map((t) => t.trim()).filter((t) => t.length > 0))].sort();
}

/** Stable string ordering that does not depend on the host locale. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorts in place by a derived key, using locale-independent comparison. */
export function sortBy<T>(items: T[], key: (item: T) => string): T[] {
  return items.sort((a, b) => compareIds(key(a), key(b)));
}

/** Lowercase, hyphenated, ASCII-only slug. Used inside derived identifiers. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
