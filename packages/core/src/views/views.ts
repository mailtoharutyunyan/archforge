/**
 * View derivation: model -> view graph.
 *
 * A view is never stored data; it is computed from the model every time. That
 * is what removes the duplication the original C4 tooling suffers from, where
 * the same system appears by hand in four diagrams and drifts in three of them.
 *
 * The important trick is *relationship lifting*: a container view of system S
 * shows S's containers, and any dependency that actually exists between a
 * component inside one container and a component inside another is lifted to
 * an edge between the two containers. Authors declare a dependency once, at
 * whatever level of detail they know, and every view stays correct.
 */

import { ArchModel } from '../model/model.ts';
import type { Element, Relation, ViewDef, ViewKind } from '../model/types.ts';
import { matches, parseSelector, type Selector } from '../selector/selector.ts';
import { compareIds, sortBy } from '../util/canonical.ts';

export interface ViewNode {
  readonly element: Element;
  /** True when the node is drawn as a boundary containing other nodes. */
  readonly isBoundary: boolean;
  /** Nodes nested inside this one, for boundary rendering. */
  readonly children: readonly ViewNode[];
}

export interface ViewEdge {
  readonly id: string;
  readonly sourceId: string;
  readonly destId: string;
  readonly description?: string;
  readonly technology?: string;
  readonly direction: 'uni' | 'bi';
  readonly tags: readonly string[];
  /**
   * Relations this edge stands for. More than one when several finer-grained
   * dependencies lift onto the same pair of coarser elements.
   */
  readonly relationIds: readonly string[];
  /** True when the edge was lifted from a deeper level rather than declared here. */
  readonly lifted: boolean;
  /** Step number for dynamic views, otherwise undefined. */
  readonly order?: number;
}

export interface DerivedView {
  readonly id: string;
  readonly kind: ViewKind;
  readonly title: string;
  readonly scopeId?: string;
  /** Flat node list in stable order; `tree` carries the nesting. */
  readonly nodes: readonly ViewNode[];
  readonly tree: readonly ViewNode[];
  readonly edges: readonly ViewEdge[];
}

/** Derives every view defined in the workspace. */
export function deriveAll(model: ArchModel): DerivedView[] {
  return model.views.map((view) => derive(model, view));
}

export function deriveById(model: ArchModel, viewId: string): DerivedView | undefined {
  const definition = model.views.find((v) => v.id === viewId);
  return definition ? derive(model, definition) : undefined;
}

export function derive(model: ArchModel, definition: ViewDef): DerivedView {
  const include = definition.include.map((text) => parseSelector(text).selector);
  const exclude = definition.exclude.map((text) => parseSelector(text).selector);

  const visible = collectVisible(model, definition);
  const filtered = applyFilters(model, visible, include, exclude);

  const edges =
    definition.kind === 'dynamic'
      ? dynamicEdges(model, definition, filtered)
      : liftEdges(model, filtered, definition.kind === 'deployment' ? hostTranslator(model) : undefined);

  const nodes = sortBy([...filtered.values()], (e) => e.id).map((element) => ({
    element,
    isBoundary: hasVisibleChild(element.id, filtered),
    children: [] as ViewNode[],
  }));

  return {
    id: definition.id,
    kind: definition.kind,
    title: definition.title,
    scopeId: definition.scopeId,
    nodes,
    tree: buildTree(nodes, filtered),
    edges,
  };
}

/**
 * Chooses which elements a view shows, per C4 level:
 *
 *  - context:    the scoped system, plus every person and system it talks to
 *  - container:  the scoped system as a boundary, its containers, plus the
 *                external people/systems those containers talk to
 *  - component:  the scoped container as a boundary, its components, plus the
 *                sibling containers and external parties they talk to
 *  - deployment: the scoped deployment node and everything nested in it
 *  - dynamic:    exactly the elements named by the steps, plus their parents
 */
function collectVisible(model: ArchModel, definition: ViewDef): Map<string, Element> {
  const visible = new Map<string, Element>();
  const add = (element: Element | undefined): void => {
    if (element) visible.set(element.id, element);
  };

  switch (definition.kind) {
    case 'context': {
      const scope = definition.scopeId ? model.element(definition.scopeId) : undefined;
      if (scope) {
        add(scope);
        // Descendants are included when looking for neighbours: dependencies
        // are almost always declared at container or component level, so a
        // system itself usually has no direct relationships of its own.
        for (const neighbour of neighboursOf(model, scope.id, true)) {
          const top = topLevelOf(model, neighbour);
          if (top.id === scope.id) continue;
          if (top.kind === 'person' || top.kind === 'system') add(top);
        }
      } else {
        // No scope: the whole landscape, i.e. every person and system.
        for (const element of model.elements) {
          if (element.kind === 'person' || element.kind === 'system') add(element);
        }
      }
      break;
    }
    case 'container': {
      const scope = definition.scopeId ? model.element(definition.scopeId) : undefined;
      if (!scope) break;
      add(scope);
      for (const container of model.children(scope.id)) {
        if (container.kind === 'container') add(container);
      }
      // Neighbours of the scope *and everything inside it*: a dependency may be
      // declared on the system, on one of its containers, or on a component
      // several levels down, and all three belong in this view.
      for (const neighbour of neighboursOf(model, scope.id, true)) {
        const outside = outsideOf(model, neighbour, scope.id);
        if (outside) add(outside);
      }
      break;
    }
    case 'component': {
      const scope = definition.scopeId ? model.element(definition.scopeId) : undefined;
      if (!scope) break;
      add(scope);
      for (const component of model.children(scope.id)) {
        if (component.kind === 'component') add(component);
      }
      for (const neighbour of neighboursOf(model, scope.id, true)) {
        const outside = outsideOf(model, neighbour, scope.id);
        if (outside) add(outside);
      }
      break;
    }
    case 'deployment': {
      const scope = definition.scopeId ? model.element(definition.scopeId) : undefined;
      if (scope) {
        add(scope);
        for (const descendant of model.descendants(scope.id)) add(descendant);
      } else {
        for (const element of model.elements) {
          if (element.kind === 'deploymentNode' || element.kind === 'infrastructureNode') {
            add(element);
          }
        }
      }
      break;
    }
    case 'dynamic': {
      for (const step of definition.steps) {
        add(model.element(step.sourceId));
        add(model.element(step.destId));
      }
      break;
    }
  }

  return visible;
}

/** Ids of everything directly related to `id`, optionally including descendants. */
function neighboursOf(model: ArchModel, id: string, includeDescendants = false): string[] {
  const scope = new Set<string>([id]);
  if (includeDescendants) {
    for (const descendant of model.descendants(id)) scope.add(descendant.id);
  }
  const out = new Set<string>();
  for (const current of scope) {
    for (const relation of model.outgoing(current)) out.add(relation.destId);
    for (const relation of model.incoming(current)) out.add(relation.sourceId);
  }
  for (const current of scope) out.delete(current);
  return [...out].sort(compareIds);
}

/** The outermost ancestor (or the element itself) for context-level display. */
function topLevelOf(model: ArchModel, id: string): Element {
  const ancestors = model.ancestors(id);
  return ancestors.length > 0 ? (ancestors[ancestors.length - 1] as Element) : model.requireElement(id);
}

/**
 * For a neighbour of something inside `scopeId`, returns the element to draw.
 *
 * Resolution order matters for view quality:
 *   1. inside the scope  -> the direct child of the scope that contains it
 *   2. a sibling of the scope -> that sibling itself
 *   3. anywhere else     -> its top-level system or person
 *
 * Step 2 is what stops a component view of `payments.api` from drawing the
 * entire `payments` system just because the API talks to a sibling container:
 * the useful picture is "the API talks to the Payments DB", not "the API talks
 * to the system it lives in".
 */
function outsideOf(model: ArchModel, neighbourId: string, scopeId: string): Element | undefined {
  const neighbour = model.element(neighbourId);
  if (!neighbour) return undefined;
  const chain = [neighbour, ...model.ancestors(neighbourId)];

  if (chain.some((e) => e.id === scopeId)) {
    const direct = chain.find((e) => e.parentId === scopeId);
    return direct ?? undefined;
  }

  // A sibling shares the scope's parent. Walk up to find it.
  const scopeParentId = model.element(scopeId)?.parentId;
  if (scopeParentId !== undefined) {
    const sibling = chain.find((e) => e.parentId === scopeParentId && e.id !== scopeId);
    if (sibling) return sibling;
  }

  return topLevelOf(model, neighbourId);
}

function applyFilters(
  model: ArchModel,
  visible: Map<string, Element>,
  include: readonly Selector[],
  exclude: readonly Selector[],
): Map<string, Element> {
  if (include.length === 0 && exclude.length === 0) return visible;
  const out = new Map<string, Element>();
  for (const [id, element] of visible) {
    const included =
      include.length === 0 || include.some((selector) => matches(selector, element, model));
    const excluded = exclude.some((selector) => matches(selector, element, model));
    if (included && !excluded) out.set(id, element);
  }
  return out;
}

function hasVisibleChild(id: string, visible: Map<string, Element>): boolean {
  for (const element of visible.values()) {
    if (element.parentId === id) return true;
  }
  return false;
}

function buildTree(nodes: readonly ViewNode[], visible: Map<string, Element>): ViewNode[] {
  const byId = new Map(nodes.map((node) => [node.element.id, node]));
  const roots: ViewNode[] = [];
  const childrenOf = new Map<string, ViewNode[]>();

  for (const node of nodes) {
    const parentId = node.element.parentId;
    if (parentId && visible.has(parentId)) {
      const siblings = childrenOf.get(parentId) ?? [];
      siblings.push(node);
      childrenOf.set(parentId, siblings);
    } else {
      roots.push(node);
    }
  }

  const attach = (node: ViewNode): ViewNode => {
    const children = (childrenOf.get(node.element.id) ?? []).map(attach);
    return { element: node.element, isBoundary: children.length > 0, children };
  };

  void byId;
  return sortBy(roots.map(attach), (node) => node.element.id);
}

/**
 * Lifts every relationship in the model onto the visible nodes.
 *
 * A relation between two hidden descendants of two visible nodes becomes an
 * edge between those visible nodes, marked `lifted` so the renderer can draw
 * it differently and so reports can explain where it came from. Relations whose
 * endpoints lift onto the same node are dropped: an element does not depend on
 * itself just because two of its parts talk.
 */
function liftEdges(
  model: ArchModel,
  visible: Map<string, Element>,
  translate?: (id: string) => string,
): ViewEdge[] {
  const anchor = (id: string): string | undefined => {
    const mapped = translate ? translate(id) : id;
    if (visible.has(mapped)) return mapped;
    for (const ancestor of model.ancestors(mapped)) {
      if (visible.has(ancestor.id)) return ancestor.id;
    }
    return undefined;
  };

  interface Accumulator {
    sourceId: string;
    destId: string;
    descriptions: string[];
    technologies: string[];
    tags: Set<string>;
    relationIds: string[];
    direction: 'uni' | 'bi';
    lifted: boolean;
  }

  const grouped = new Map<string, Accumulator>();

  for (const relation of model.relations) {
    const sourceId = anchor(relation.sourceId);
    const destId = anchor(relation.destId);
    if (!sourceId || !destId || sourceId === destId) continue;

    const key = `${sourceId}->${destId}`;
    const lifted = sourceId !== relation.sourceId || destId !== relation.destId;
    const existing = grouped.get(key);
    const accumulator: Accumulator =
      existing ??
      {
        sourceId,
        destId,
        descriptions: [],
        technologies: [],
        tags: new Set<string>(),
        relationIds: [],
        direction: 'uni',
        lifted: true,
      };

    if (relation.description) accumulator.descriptions.push(relation.description);
    if (relation.technology) accumulator.technologies.push(relation.technology);
    for (const tag of relation.tags) accumulator.tags.add(tag);
    accumulator.relationIds.push(relation.id);
    if (relation.direction === 'bi') accumulator.direction = 'bi';
    // An edge counts as declared at this level if any contributing relation was.
    accumulator.lifted = accumulator.lifted && lifted;
    grouped.set(key, accumulator);
  }

  // Collapse `a->b` and `b->a` into one bidirectional edge.
  const consumed = new Set<string>();
  const edges: ViewEdge[] = [];

  for (const [key, accumulator] of [...grouped].sort((a, b) => compareIds(a[0], b[0]))) {
    if (consumed.has(key)) continue;
    const reverseKey = `${accumulator.destId}->${accumulator.sourceId}`;
    const reverse = grouped.get(reverseKey);
    let direction = accumulator.direction;
    let relationIds = [...accumulator.relationIds];
    let descriptions = [...accumulator.descriptions];
    let technologies = [...accumulator.technologies];
    const tags = new Set(accumulator.tags);

    if (reverse && reverseKey !== key) {
      consumed.add(reverseKey);
      direction = 'bi';
      relationIds = [...relationIds, ...reverse.relationIds];
      descriptions = [...descriptions, ...reverse.descriptions];
      technologies = [...technologies, ...reverse.technologies];
      for (const tag of reverse.tags) tags.add(tag);
    }
    consumed.add(key);

    edges.push({
      id: key,
      sourceId: accumulator.sourceId,
      destId: accumulator.destId,
      description: uniqueJoin(descriptions),
      technology: uniqueJoin(technologies),
      direction,
      tags: [...tags].sort(compareIds),
      relationIds: [...new Set(relationIds)].sort(compareIds),
      lifted: accumulator.lifted,
    });
  }

  return sortBy(edges, (edge) => edge.id);
}

/**
 * Maps a container or component onto the deployment node that hosts it, via
 * `instanceOf`. Without this a deployment view is just a nesting diagram; with
 * it, the same declared dependencies appear as traffic between the things that
 * actually run — which is the question an infrastructure reader is asking.
 *
 * When several nodes instantiate the same container (a deployment in two
 * regions), the lowest id wins so the projection stays deterministic.
 */
function hostTranslator(model: ArchModel): (id: string) => string {
  const hostOf = new Map<string, string>();
  for (const element of model.elements) {
    if (!element.instanceOf) continue;
    const existing = hostOf.get(element.instanceOf);
    if (existing === undefined || compareIds(element.id, existing) < 0) {
      hostOf.set(element.instanceOf, element.id);
    }
  }
  return (id: string): string => {
    const direct = hostOf.get(id);
    if (direct) return direct;
    // A component's traffic is attributed to the node hosting its container.
    for (const ancestor of model.ancestors(id)) {
      const host = hostOf.get(ancestor.id);
      if (host) return host;
    }
    return id;
  };
}

/** Ordered edges for a dynamic view, one per declared step. */
function dynamicEdges(
  model: ArchModel,
  definition: ViewDef,
  visible: Map<string, Element>,
): ViewEdge[] {
  const edges: ViewEdge[] = [];
  for (const step of definition.steps) {
    if (!visible.has(step.sourceId) || !visible.has(step.destId)) continue;
    const declared = model
      .outgoing(step.sourceId)
      .find((relation) => relation.destId === step.destId);
    edges.push({
      id: `${definition.id}#${step.order}`,
      sourceId: step.sourceId,
      destId: step.destId,
      description: step.description ?? declared?.description,
      technology: step.technology ?? declared?.technology,
      direction: 'uni',
      tags: declared?.tags ?? [],
      relationIds: declared ? [declared.id] : [],
      lifted: false,
      order: step.order,
    });
  }
  return edges;
}

function uniqueJoin(values: readonly string[]): string | undefined {
  const unique = [...new Set(values.filter((v) => v.trim().length > 0))];
  if (unique.length === 0) return undefined;
  if (unique.length === 1) return unique[0];
  return unique.sort(compareIds).join(', ');
}

/**
 * Relations a dynamic view references that do not exist in the model. Reported
 * as a warning rather than an error: a sequence can legitimately describe a
 * step that is not a structural dependency, but far more often it is a typo.
 */
export function undeclaredSteps(model: ArchModel, definition: ViewDef): string[] {
  if (definition.kind !== 'dynamic') return [];
  const missing: string[] = [];
  for (const step of definition.steps) {
    const exists = model
      .outgoing(step.sourceId)
      .some((relation) => relation.destId === step.destId);
    const reverse = model
      .outgoing(step.destId)
      .some((relation) => relation.destId === step.sourceId && relation.direction === 'bi');
    if (!exists && !reverse) missing.push(`${step.sourceId} -> ${step.destId}`);
  }
  return missing;
}

export type { Relation };
