/**
 * ScanResult -> Workspace.
 *
 * Turns what a scanner inferred into a real model you can open, edit and own.
 * This is the "point it at a repository and get a diagram" path.
 *
 * Every element and relationship produced here keeps its `inferred`
 * provenance, with the detector, confidence class and evidence intact. That
 * matters more than it sounds: the moment inferred facts become
 * indistinguishable from declared ones, drift detection has nothing to compare
 * and the tool starts lying confidently. So the synthesised model is a
 * *starting point* for a human to confirm, not an answer.
 */

import type { Element, Relation, RuleDef, ViewDef, Workspace } from '../model/types.ts';
import { compareIds, normalizeTags, slug, sortBy } from '../util/canonical.ts';
import type { InferredExternal, ScanResult } from './types.ts';

export interface SynthesizeOptions {
  /** Workspace name. Defaults to the repository directory name. */
  readonly name?: string;
  /** Include a starter rule set so `arch check` does something immediately. */
  readonly includeRules?: boolean;
  /** Minimum confidence to include. Defaults to `low` — show everything found. */
  readonly minConfidence?: 'low' | 'medium' | 'high';
}

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

export function synthesizeWorkspace(
  scan: ScanResult,
  options: SynthesizeOptions = {},
): Workspace {
  const name = options.name ?? 'Scanned system';
  const threshold = CONFIDENCE_RANK[options.minConfidence ?? 'low'];
  const relations: Relation[] = [];

  /**
   * Elements are collected by id rather than appended, because two scanners
   * legitimately describe the same thing: the JVM scanner finds Redis from a
   * `StringRedisTemplate`, and the Compose scanner finds it from an `image:
   * redis` line. Both slug to the same identity, and emitting it twice would
   * produce a model that does not compile. When they collide, the sighting with
   * the higher confidence wins and its evidence is kept.
   */
  const byId = new Map<string, Element>();
  const elements = {
    push(element: Element): void {
      const existing = byId.get(element.id);
      if (!existing) {
        byId.set(element.id, element);
        return;
      }
      const rank = (candidate: Element): number =>
        candidate.provenance.source === 'inferred'
          ? CONFIDENCE_RANK[candidate.provenance.confidence]
          : 3;
      if (rank(element) > rank(existing)) {
        byId.set(element.id, { ...element, description: element.description ?? existing.description });
      }
    },
    some(predicate: (element: Element) => boolean): boolean {
      return [...byId.values()].some(predicate);
    },
  };

  const systemId = slug(name) || 'system';

  // ---- the scanned system itself
  elements.push({
    id: systemId,
    localId: systemId,
    kind: 'system',
    name,
    description: `Reverse-engineered from source. ${scan.files.length} files scanned.`,
    tags: ['inferred'],
    properties: {},
    provenance: {
      source: 'inferred',
      detector: 'synthesize/root',
      confidence: 'high',
      evidence: [{ file: scan.files[0] ?? '.', line: 1, snippet: 'repository root' }],
    },
  });

  // ---- one container per build module
  const modules = new Set<string>();
  for (const component of scan.components) modules.add(component.module);
  for (const relation of scan.relations) {
    const match = /^module-(.*)$/.exec(relation.sourceId);
    if (match) modules.add(match[1] === 'root' ? '' : (match[1] as string));
  }

  /** Scanner module id (`module-services-api`) -> our container id. */
  const containerOf = new Map<string, string>();

  for (const module of [...modules].sort(compareIds)) {
    const local = slug(module) || 'app';
    const containerId = `${systemId}.${local}`;
    containerOf.set(`module-${slug(module) || 'root'}`, containerId);

    const componentsHere = scan.components.filter((component) => component.module === module);
    const technology = dominantTechnology(componentsHere.map((c) => c.technology));

    elements.push({
      id: containerId,
      localId: local,
      kind: 'container',
      name: module === '' ? name : lastSegment(module),
      description: module === '' ? 'Root module.' : `Module at ${module}/`,
      technology,
      tags: ['inferred'],
      properties: {},
      parentId: systemId,
      // The binding that makes future drift checks possible. This single line
      // is the difference between a one-off picture and a living document.
      sourcePath: module === '' ? undefined : module,
      provenance: {
        source: 'inferred',
        detector: 'synthesize/module',
        confidence: 'high',
        evidence: [
          {
            file: componentsHere[0]?.sourcePath ?? (module === '' ? '.' : module),
            line: 1,
            snippet: `module ${module || '(root)'}`,
          },
        ],
      },
    });

    // ---- components inside the container
    for (const component of componentsHere) {
      if (CONFIDENCE_RANK[component.provenance.confidence] < threshold) continue;
      elements.push({
        id: `${containerId}.${component.id}`,
        localId: component.id,
        kind: 'component',
        subtype: component.subtype,
        name: component.name,
        technology: component.technology,
        tags: ['inferred'],
        properties: {},
        parentId: containerId,
        sourcePath: component.sourcePath,
        provenance: component.provenance,
      });
    }
  }

  // ---- external dependencies as top-level elements
  /** Scanner external id -> our element id. */
  const externalOf = new Map<string, string>();

  for (const external of scan.externals) {
    if (CONFIDENCE_RANK[external.provenance.confidence] < threshold) continue;
    const id = slug(`${external.subtype}-${external.name}`) || external.id;
    externalOf.set(external.id, id);
    elements.push({
      id,
      localId: id,
      kind: 'system',
      subtype: subtypeFor(external),
      name: external.name,
      description: external.unresolved
        ? 'Detected, but the scanner could not identify the target.'
        : undefined,
      technology: external.technology,
      tags: normalizeTags(['inferred', 'external', ...(external.unresolved ? ['unresolved'] : [])]),
      properties: {},
      provenance: external.provenance,
    });
  }

  // ---- relationships
  for (const relation of scan.relations) {
    if (CONFIDENCE_RANK[relation.provenance.confidence] < threshold) continue;
    const from = containerOf.get(relation.sourceId) ?? externalOf.get(relation.sourceId);
    const to = externalOf.get(relation.destId) ?? containerOf.get(relation.destId);
    if (!from || !to || from === to) continue;

    // Inbound means the target pushes into our code, so the arrow reverses.
    const sourceId = relation.direction === 'inbound' ? to : from;
    const destId = relation.direction === 'inbound' ? from : to;

    const id = `${sourceId}->${destId}`;
    if (relations.some((existing) => existing.id === id)) continue;

    relations.push({
      id,
      sourceId,
      destId,
      description: relation.description ?? describeRelation(relation.technology),
      technology: relation.technology,
      direction: 'uni',
      tags: ['inferred'],
      properties: {},
      provenance: relation.provenance,
    });
  }

  // ---- views
  const views: ViewDef[] = [
    {
      id: 'landscape',
      kind: 'context',
      title: `${name} — landscape`,
      scopeId: systemId,
      include: [],
      exclude: [],
      steps: [],
    },
    {
      id: 'containers',
      kind: 'container',
      title: `${name} — containers`,
      scopeId: systemId,
      include: [],
      exclude: [],
      steps: [],
    },
  ];

  for (const [, containerId] of [...containerOf].sort((a, b) => compareIds(a[1], b[1]))) {
    const hasComponents = elements.some((element) => element.parentId === containerId);
    if (!hasComponents) continue;
    const local = containerId.split('.').pop() as string;
    views.push({
      id: `${local}-components`,
      kind: 'component',
      title: `${lastSegment(local)} — components`,
      scopeId: containerId,
      include: [],
      exclude: [],
      steps: [],
    });
  }

  const rules: RuleDef[] = (options.includeRules ?? true)
    ? [
        {
          id: 'no-cycles',
          title: 'Architecture must be acyclic',
          severity: 'error',
          assertions: [{ type: 'forbidCycles' }],
        },
        {
          id: 'confirm-inferred',
          title: 'Inferred elements need a human to confirm them',
          severity: 'info',
          assertions: [
            { type: 'requireField', field: 'description', on: 'element(provenance:inferred)' },
          ],
        },
      ]
    : [];

  return {
    name,
    description:
      'Generated by scanning a repository. Every element is marked `inferred`: review it, ' +
      'correct it, and delete the `inferred` tags as you confirm each one. Once the ' +
      '`source` bindings are right, `arch drift` will keep this honest.',
    elements: sortBy([...byId.values()], (element) => element.id),
    relations: sortBy(relations, (relation) => relation.id),
    views,
    rules,
    properties: { generatedBy: 'archforge scan' },
  };
}

function subtypeFor(external: InferredExternal): string {
  switch (external.subtype) {
    case 'broker':
      return 'queue';
    case 'infrastructure':
      return 'service';
    case 'proxy':
      return 'service';
    default:
      return external.subtype;
  }
}

function describeRelation(technology: string | undefined): string | undefined {
  if (!technology) return undefined;
  if (/kafka|sqs|sns|pub\/sub|rabbit|nats/i.test(technology)) return 'Publishes and consumes';
  if (/redis|memcached/i.test(technology)) return 'Caches in';
  if (/sql|postgres|mysql|mongo|oracle|dynamo|cassandra/i.test(technology)) return 'Reads and writes';
  if (/http|grpc|feign/i.test(technology)) return 'Calls';
  return undefined;
}

/** The most common non-empty technology in a group, ties broken stably. */
function dominantTechnology(values: readonly (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [value, count] of [...counts].sort((a, b) => compareIds(a[0], b[0]))) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function lastSegment(path: string): string {
  const segment = path.split('/').pop() ?? path;
  return segment
    .split(/[-_]/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
