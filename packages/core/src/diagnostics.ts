/**
 * Diagnostics shared by the parser, the compiler and the rule engine, so a CLI,
 * an editor and a CI job all report problems the same way.
 */

import type { Severity, SourceLoc } from './model/types.ts';

export interface Diagnostic {
  readonly severity: Severity;
  /** Stable machine-readable code, e.g. `parse/unexpected-token`. */
  readonly code: string;
  readonly message: string;
  readonly loc?: SourceLoc;
  /** Optional actionable suggestion, shown indented under the message. */
  readonly hint?: string;
}

export function diag(
  severity: Severity,
  code: string,
  message: string,
  loc?: SourceLoc,
  hint?: string,
): Diagnostic {
  return { severity, code, message, loc, hint };
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

export function countBySeverity(
  diagnostics: readonly Diagnostic[],
): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity] += 1;
  return counts;
}

/** Thrown only for programming errors; user input produces diagnostics instead. */
export class ArchInternalError extends Error {}

/**
 * Renders `file:line:col` the way editors and terminals expect, so the location
 * is click-through in most tooling.
 */
export function formatLoc(loc: SourceLoc | undefined): string {
  if (!loc) return '';
  return `${loc.file}:${loc.line}:${loc.column}`;
}

/**
 * Sorts diagnostics into a stable, human-sensible order: by file, then
 * position, then severity, then code. Independent of discovery order.
 */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return [...diagnostics].sort((a, b) => {
    const fa = a.loc?.file ?? '';
    const fb = b.loc?.file ?? '';
    if (fa !== fb) return fa < fb ? -1 : 1;
    const la = a.loc?.line ?? 0;
    const lb = b.loc?.line ?? 0;
    if (la !== lb) return la - lb;
    const ca = a.loc?.column ?? 0;
    const cb = b.loc?.column ?? 0;
    if (ca !== cb) return ca - cb;
    if (a.severity !== b.severity) return rank[a.severity] - rank[b.severity];
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });
}
