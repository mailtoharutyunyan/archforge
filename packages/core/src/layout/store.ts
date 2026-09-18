/**
 * Manual layout persistence.
 *
 * Layout is stored separately from architecture semantics, in its own file per
 * view. That separation is what lets a model change reflow a diagram without
 * touching the positions a human deliberately chose — and what stops a diagram
 * tweak from showing up as a semantic change in a pull request.
 */

import { canonicalJson } from '../util/canonical.ts';
import type { DerivedView } from '../views/views.ts';

export interface Position {
  readonly x: number;
  readonly y: number;
}

export interface ViewLayoutFile {
  readonly view: string;
  readonly direction?: 'TB' | 'LR';
  readonly positions: Readonly<Record<string, Position>>;
}

export function emptyLayout(viewId: string): ViewLayoutFile {
  return { view: viewId, positions: {} };
}

/** Parses a layout file, tolerating an absent or malformed file. */
export function parseLayout(text: string, viewId: string): ViewLayoutFile {
  try {
    const raw = JSON.parse(text) as Partial<ViewLayoutFile>;
    const positions: Record<string, Position> = {};
    for (const [id, value] of Object.entries(raw.positions ?? {})) {
      if (
        value &&
        typeof value === 'object' &&
        Number.isFinite((value as Position).x) &&
        Number.isFinite((value as Position).y)
      ) {
        positions[id] = { x: Math.round((value as Position).x), y: Math.round((value as Position).y) };
      }
    }
    return {
      view: raw.view ?? viewId,
      direction: raw.direction === 'LR' ? 'LR' : raw.direction === 'TB' ? 'TB' : undefined,
      positions,
    };
  } catch {
    return emptyLayout(viewId);
  }
}

/** Canonical, sorted, newline-terminated — safe to commit. */
export function serializeLayout(file: ViewLayoutFile): string {
  return canonicalJson({
    view: file.view,
    direction: file.direction,
    positions: file.positions,
  });
}

/**
 * Drops positions for elements the view no longer contains, and keeps every
 * other pin untouched. Called after a model change so stale entries do not
 * accumulate, while unrelated manual work survives.
 */
export function pruneLayout(file: ViewLayoutFile, view: DerivedView): {
  layout: ViewLayoutFile;
  removed: string[];
} {
  const present = new Set(view.nodes.map((node) => node.element.id));
  const positions: Record<string, Position> = {};
  const removed: string[] = [];

  for (const [id, position] of Object.entries(file.positions)) {
    if (present.has(id)) positions[id] = position;
    else removed.push(id);
  }
  return {
    layout: { view: file.view, direction: file.direction, positions },
    removed: removed.sort(),
  };
}

/** Records or updates a pin. Returns a new file; the input is not mutated. */
export function setPosition(file: ViewLayoutFile, id: string, position: Position): ViewLayoutFile {
  return {
    ...file,
    positions: {
      ...file.positions,
      [id]: { x: Math.round(position.x), y: Math.round(position.y) },
    },
  };
}

/** Removes a pin so the element returns to automatic placement. */
export function clearPosition(file: ViewLayoutFile, id: string): ViewLayoutFile {
  const positions = { ...file.positions };
  delete positions[id];
  return { ...file, positions };
}
