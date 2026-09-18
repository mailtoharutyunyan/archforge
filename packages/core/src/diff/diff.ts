/**
 * Architecture diff.
 *
 * Treating architecture like source code means being able to answer "what
 * changed?" between two commits, two branches, or a proposal and the current
 * state. Because ids are stable, this is a structural comparison rather than a
 * text comparison, so a reformatted file produces an empty diff and a renamed
 * technology produces a precise one.
 *
 * The diff is also the review surface for AI-proposed changes: an agent edits
 * the DSL, and the human reads *this* rather than a patch.
 */

import type { ArchModel } from '../model/model.ts';
import type { Element, Relation } from '../model/types.ts';
import { compareIds, sortBy } from '../util/canonical.ts';

export type ChangeType = 'added' | 'removed' | 'changed';

/** One altered field on an otherwise surviving entity. */
export interface FieldChange {
  readonly field: string;
  readonly before?: string;
  readonly after?: string;
}

export interface ElementChange {
  readonly type: ChangeType;
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly fields: readonly FieldChange[];
}

export interface RelationChange {
  readonly type: ChangeType;
  readonly id: string;
  readonly sourceId: string;
  readonly destId: string;
  readonly label: string;
  readonly fields: readonly FieldChange[];
}

export interface ArchDiff {
  readonly elements: readonly ElementChange[];
  readonly relations: readonly RelationChange[];
  readonly summary: {
    readonly elementsAdded: number;
    readonly elementsRemoved: number;
    readonly elementsChanged: number;
    readonly relationsAdded: number;
    readonly relationsRemoved: number;
    readonly relationsChanged: number;
    readonly total: number;
  };
}

/** Fields compared on an element. Provenance and layout are deliberately excluded. */
const ELEMENT_FIELDS: readonly {
  name: string;
  read: (element: Element) => string | undefined;
}[] = [
  { name: 'name', read: (e) => e.name },
  { name: 'kind', read: (e) => e.kind },
  { name: 'subtype', read: (e) => e.subtype },
  { name: 'description', read: (e) => e.description },
  { name: 'technology', read: (e) => e.technology },
  { name: 'owner', read: (e) => e.owner },
  { name: 'url', read: (e) => e.url },
  { name: 'parent', read: (e) => e.parentId },
  { name: 'source', read: (e) => e.sourcePath },
  { name: 'instanceOf', read: (e) => e.instanceOf },
  { name: 'tags', read: (e) => (e.tags.length > 0 ? e.tags.join(', ') : undefined) },
  {
    name: 'properties',
    read: (e) => {
      const keys = Object.keys(e.properties).sort();
      if (keys.length === 0) return undefined;
      return keys.map((key) => `${key}=${e.properties[key]}`).join(', ');
    },
  },
];

const RELATION_FIELDS: readonly {
  name: string;
  read: (relation: Relation) => string | undefined;
}[] = [
  { name: 'description', read: (r) => r.description },
  { name: 'technology', read: (r) => r.technology },
  { name: 'protocol', read: (r) => r.protocol },
  { name: 'direction', read: (r) => r.direction },
  { name: 'tags', read: (r) => (r.tags.length > 0 ? r.tags.join(', ') : undefined) },
];

export function diff(before: ArchModel, after: ArchModel): ArchDiff {
  const elements = diffElements(before, after);
  const relations = diffRelations(before, after);

  const count = (changes: readonly { type: ChangeType }[], type: ChangeType): number =>
    changes.filter((change) => change.type === type).length;

  return {
    elements,
    relations,
    summary: {
      elementsAdded: count(elements, 'added'),
      elementsRemoved: count(elements, 'removed'),
      elementsChanged: count(elements, 'changed'),
      relationsAdded: count(relations, 'added'),
      relationsRemoved: count(relations, 'removed'),
      relationsChanged: count(relations, 'changed'),
      total: elements.length + relations.length,
    },
  };
}

function diffElements(before: ArchModel, after: ArchModel): ElementChange[] {
  const beforeById = new Map(before.elements.map((element) => [element.id, element]));
  const afterById = new Map(after.elements.map((element) => [element.id, element]));
  const changes: ElementChange[] = [];

  for (const [id, element] of beforeById) {
    const next = afterById.get(id);
    if (!next) {
      changes.push({
        type: 'removed',
        id,
        name: element.name,
        kind: element.kind,
        fields: [],
      });
      continue;
    }
    const fields = compareFields(ELEMENT_FIELDS, element, next);
    if (fields.length > 0) {
      changes.push({ type: 'changed', id, name: next.name, kind: next.kind, fields });
    }
  }

  for (const [id, element] of afterById) {
    if (beforeById.has(id)) continue;
    changes.push({ type: 'added', id, name: element.name, kind: element.kind, fields: [] });
  }

  return sortBy(changes, (change) => `${typeRank(change.type)}|${change.id}`);
}

function diffRelations(before: ArchModel, after: ArchModel): RelationChange[] {
  const beforeById = new Map(before.relations.map((relation) => [relation.id, relation]));
  const afterById = new Map(after.relations.map((relation) => [relation.id, relation]));
  const changes: RelationChange[] = [];

  const label = (model: ArchModel, relation: Relation): string => {
    const source = model.element(relation.sourceId)?.name ?? relation.sourceId;
    const dest = model.element(relation.destId)?.name ?? relation.destId;
    return `${source} → ${dest}`;
  };

  for (const [id, relation] of beforeById) {
    const next = afterById.get(id);
    if (!next) {
      changes.push({
        type: 'removed',
        id,
        sourceId: relation.sourceId,
        destId: relation.destId,
        label: label(before, relation),
        fields: [],
      });
      continue;
    }
    const fields = compareFields(RELATION_FIELDS, relation, next);
    if (fields.length > 0) {
      changes.push({
        type: 'changed',
        id,
        sourceId: next.sourceId,
        destId: next.destId,
        label: label(after, next),
        fields,
      });
    }
  }

  for (const [id, relation] of afterById) {
    if (beforeById.has(id)) continue;
    changes.push({
      type: 'added',
      id,
      sourceId: relation.sourceId,
      destId: relation.destId,
      label: label(after, relation),
      fields: [],
    });
  }

  return sortBy(changes, (change) => `${typeRank(change.type)}|${change.id}`);
}

function compareFields<T>(
  definitions: readonly { name: string; read: (value: T) => string | undefined }[],
  before: T,
  after: T,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const definition of definitions) {
    const previous = definition.read(before);
    const next = definition.read(after);
    if (previous === next) continue;
    changes.push({ field: definition.name, before: previous, after: next });
  }
  return changes;
}

/** Additions, then removals, then modifications — how humans read a changelog. */
function typeRank(type: ChangeType): string {
  return type === 'added' ? '0' : type === 'removed' ? '1' : '2';
}

export function isEmpty(result: ArchDiff): boolean {
  return result.summary.total === 0;
}

/**
 * Human-readable diff, close to the shape of a release note. Kept here rather
 * than in the CLI so the web UI and any CI comment render identically.
 */
export function formatDiff(result: ArchDiff, options: { colour?: boolean } = {}): string {
  const colour = options.colour ?? false;
  const paint = (code: string, text: string): string =>
    colour ? `[${code}m${text}[0m` : text;

  if (isEmpty(result)) return 'No architectural changes.\n';

  const lines: string[] = [];

  const section = (title: string, body: readonly string[]): void => {
    if (body.length === 0) return;
    lines.push(paint('1', title));
    lines.push(...body);
    lines.push('');
  };

  section(
    'Elements',
    result.elements.map((change) => {
      if (change.type === 'added') {
        return paint('32', `  + ${change.name} (${change.kind}) ${dim(change.id, colour)}`);
      }
      if (change.type === 'removed') {
        return paint('31', `  - ${change.name} (${change.kind}) ${dim(change.id, colour)}`);
      }
      const fields = change.fields
        .map((field) => `      ${field.field}: ${show(field.before)} → ${show(field.after)}`)
        .join('\n');
      return `${paint('33', `  ~ ${change.name}`)} ${dim(change.id, colour)}\n${fields}`;
    }),
  );

  section(
    'Relationships',
    result.relations.map((change) => {
      if (change.type === 'added') return paint('32', `  + ${change.label}`);
      if (change.type === 'removed') return paint('31', `  - ${change.label}`);
      const fields = change.fields
        .map((field) => `      ${field.field}: ${show(field.before)} → ${show(field.after)}`)
        .join('\n');
      return `${paint('33', `  ~ ${change.label}`)}\n${fields}`;
    }),
  );

  const summary = result.summary;
  lines.push(
    `${summary.elementsAdded + summary.relationsAdded} added, ` +
      `${summary.elementsRemoved + summary.relationsRemoved} removed, ` +
      `${summary.elementsChanged + summary.relationsChanged} changed.`,
  );
  return `${lines.join('\n')}\n`;
}

function show(value: string | undefined): string {
  return value === undefined ? '(none)' : JSON.stringify(value);
}

function dim(text: string, colour: boolean): string {
  return colour ? `[2m${text}[0m` : text;
}

/**
 * Applies a diff to a workspace, used to prove the diff is complete: for any
 * two models, applying `diff(a, b)` to `a` must yield something structurally
 * equal to `b`. The property test that exercises this is what stops the diff
 * from quietly losing a field when the model grows one.
 */
export function applyDiff(before: ArchModel, result: ArchDiff, after: ArchModel): {
  elements: Element[];
  relations: Relation[];
} {
  const elements = new Map(before.elements.map((element) => [element.id, element]));
  const relations = new Map(before.relations.map((relation) => [relation.id, relation]));

  for (const change of result.elements) {
    if (change.type === 'removed') {
      elements.delete(change.id);
      continue;
    }
    const source = after.element(change.id);
    if (source) elements.set(change.id, source);
  }
  for (const change of result.relations) {
    if (change.type === 'removed') {
      relations.delete(change.id);
      continue;
    }
    const source = after.relation(change.id);
    if (source) relations.set(change.id, source);
  }

  return {
    elements: [...elements.values()].sort((a, b) => compareIds(a.id, b.id)),
    relations: [...relations.values()].sort((a, b) => compareIds(a.id, b.id)),
  };
}
