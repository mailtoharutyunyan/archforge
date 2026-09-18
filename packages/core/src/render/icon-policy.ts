/**
 * Whether a node gets an icon, and which one.
 *
 * This lives in its own module because two places need the same answer and
 * neither may depend on the other: layout has to reserve the space, and the
 * renderer has to draw the mark. If they disagree, text either collides with
 * the icon or floats in a gap.
 */

import type { Element } from '../model/types.ts';
import { resolveIcon, type IconDef } from './icons.ts';

/**
 * Subtypes whose built-in glyph is specific enough to be worth drawing: a
 * cylinder reads as "database" instantly, a stack of bars reads as "queue".
 */
const MEANINGFUL_SUBTYPES: ReadonlySet<string> = new Set([
  'database',
  'cache',
  'queue',
  'topic',
  'api',
  'function',
  'browser',
  'mobileApp',
]);

/**
 * A real technology logo is the most useful mark on an architecture diagram.
 * A *generic* placeholder repeated on every node is the opposite: it costs
 * space, adds noise and tells the reader nothing — five systems all wearing
 * the same grey grid glyph is worse than five systems wearing none. So an icon
 * is drawn only when it is specific: a vendored brand mark, or a built-in
 * glyph whose shape carries meaning.
 */
export function iconFor(element: Element): IconDef | undefined {
  // A person already has the head-and-shoulders cue; a logo would fight it.
  if (element.kind === 'person') return undefined;

  const icon = resolveIcon({
    kind: element.kind,
    subtype: element.subtype,
    technology: element.technology,
    tags: element.tags,
    explicit: element.properties['icon'],
  });
  if (!icon) return undefined;

  if (icon.pack !== 'builtin') return icon;
  if (element.subtype !== undefined && MEANINGFUL_SUBTYPES.has(element.subtype)) return icon;
  return undefined;
}

export function hasIcon(element: Element): boolean {
  return iconFor(element) !== undefined;
}
