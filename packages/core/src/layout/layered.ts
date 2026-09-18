/**
 * Deterministic hierarchical layout.
 *
 * Why not ELK or dagre: both are good, but both are dependencies that would
 * have to run identically in Node and in a browser to keep rendered SVG
 * byte-stable, and neither guarantees that across versions. Since stable output
 * is the property the whole Git/CI story rests on, layout is implemented here
 * with no floating-point accumulation, no randomness, and every tie broken by
 * element id.
 *
 * The algorithm is classic Sugiyama, applied recursively so that boundaries
 * (a system containing containers) get laid out inside-out:
 *
 *   1. size leaves from their text
 *   2. recurse into each boundary to learn its size
 *   3. project edges onto the current sibling level
 *   4. break cycles, assign layers by longest path
 *   5. order within layers by barycentre, ties by id
 *   6. assign coordinates, then translate children into parent space
 */

import type { DerivedView, ViewNode } from '../views/views.ts';
import { hasIcon } from '../render/icon-policy.ts';
import { compareIds } from '../util/canonical.ts';
import { measureText, wrapText } from '../util/text.ts';

export type Direction = 'TB' | 'LR';

export interface LayoutOptions {
  readonly direction?: Direction;
  /** Gap between siblings within one layer. */
  readonly nodeSep?: number;
  /** Gap between consecutive layers. */
  readonly layerSep?: number;
  /** Outer margin around the whole drawing. */
  readonly margin?: number;
  /** Manual positions, absolute, keyed by element id. */
  readonly overrides?: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
}

export interface NodeBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Nesting depth, 0 for top level. Used for boundary styling. */
  readonly depth: number;
  readonly isBoundary: boolean;
  /** True when the position came from a manual override rather than the solver. */
  readonly pinned: boolean;
}

export interface EdgeRoute {
  readonly id: string;
  readonly points: readonly { readonly x: number; readonly y: number }[];
  readonly labelX: number;
  readonly labelY: number;
  readonly labelWidth: number;
}

export interface Layout {
  readonly viewId: string;
  readonly direction: Direction;
  readonly nodes: readonly NodeBox[];
  readonly edges: readonly EdgeRoute[];
  readonly width: number;
  readonly height: number;
}

export const NODE_MIN_WIDTH = 216;
export const NODE_MAX_WIDTH = 296;
export const BOUNDARY_PADDING = 28;
export const BOUNDARY_HEADER = 38;

/**
 * Icon geometry. The icon sits in its own tile on the left of a node rather
 * than as a small mark in a corner: a technology logo is the fastest thing to
 * recognise on an architecture diagram, so it gets real space and the text
 * lays out beside it.
 */
export const ICON_TILE = 42;
export const ICON_GLYPH = 26;
export const NODE_PADDING = 14;
/** Horizontal space a node reserves for the icon tile and its gap. */
export const ICON_GUTTER = ICON_TILE + 12;

const DEFAULTS = {
  direction: 'TB' as Direction,
  nodeSep: 56,
  layerSep: 88,
  margin: 40,
};

export const NAME_FONT_SIZE = 14;
export const META_FONT_SIZE = 11;
export const EDGE_FONT_SIZE = 11;

/** Text block a node renders, computed once and reused by the renderer. */
export interface NodeText {
  readonly nameLines: readonly string[];
  readonly typeLine: string;
  readonly technologyLines: readonly string[];
  readonly descriptionLines: readonly string[];
}

export function nodeText(node: ViewNode): NodeText {
  const element = node.element;
  // Reserve the icon gutter only when an icon will actually be drawn, so a
  // node without one is not left with a dead column of whitespace.
  const gutter = !node.isBoundary && hasIcon(element) ? ICON_GUTTER : 0;
  const inner = NODE_MAX_WIDTH - 2 * NODE_PADDING - gutter;
  const typeLine = `[${element.subtype ?? element.kind}${element.technology ? `: ${element.technology}` : ''}]`;
  return {
    nameLines: wrapText(element.name, NAME_FONT_SIZE, inner),
    typeLine,
    technologyLines: wrapText(typeLine, META_FONT_SIZE, inner),
    descriptionLines: node.isBoundary
      ? []
      : wrapText(element.description ?? '', META_FONT_SIZE, inner).slice(0, 3),
  };
}

export function layout(view: DerivedView, options: LayoutOptions = {}): Layout {
  const direction = options.direction ?? DEFAULTS.direction;
  const nodeSep = options.nodeSep ?? DEFAULTS.nodeSep;
  const layerSep = options.layerSep ?? DEFAULTS.layerSep;
  const margin = options.margin ?? DEFAULTS.margin;
  const overrides = options.overrides ?? {};

  // Absolute positions accumulate here as the recursion unwinds.
  const boxes = new Map<string, { x: number; y: number; width: number; height: number; depth: number; isBoundary: boolean; pinned: boolean }>();

  // Edge endpoints are needed at every level, so project once up front.
  const parentOf = new Map<string, string | undefined>();
  const collect = (nodes: readonly ViewNode[], parent: string | undefined): void => {
    for (const node of nodes) {
      parentOf.set(node.element.id, parent);
      collect(node.children, node.element.id);
    }
  };
  collect(view.tree, undefined);

  interface Sized {
    node: ViewNode;
    width: number;
    height: number;
    /** Local offsets of descendants, filled in for boundaries. */
    inner: Map<string, { x: number; y: number; width: number; height: number; depth: number; isBoundary: boolean }>;
  }

  const sizeOf = (node: ViewNode, depth: number): Sized => {
    if (node.children.length === 0) {
      const text = nodeText(node);
      const lines = text.nameLines.length + text.technologyLines.length + text.descriptionLines.length;
      const widest = Math.max(
        ...text.nameLines.map((line) => measureText(line, NAME_FONT_SIZE)),
        ...text.technologyLines.map((line) => measureText(line, META_FONT_SIZE)),
        ...text.descriptionLines.map((line) => measureText(line, META_FONT_SIZE)),
        0,
      );
      const width = clamp(
        Math.ceil(widest) +
          2 * NODE_PADDING +
          (hasIcon(node.element) ? ICON_GUTTER : 0),
        NODE_MIN_WIDTH,
        NODE_MAX_WIDTH,
      );
      // Tall enough for the text, and never shorter than the icon tile plus
      // its padding, so a one-line node still looks deliberate.
      const height = Math.max(
        ICON_TILE + 2 * NODE_PADDING + 8,
        2 * NODE_PADDING + lines * 17 + 4,
      );
      return { node, width, height, inner: new Map() };
    }

    // Boundary: lay its children out, then wrap them.
    const child = solve(node.children, depth + 1, node.element.id);
    const inner = new Map<string, { x: number; y: number; width: number; height: number; depth: number; isBoundary: boolean }>();
    for (const [id, box] of child.positions) {
      inner.set(id, {
        x: box.x + BOUNDARY_PADDING,
        y: box.y + BOUNDARY_HEADER,
        width: box.width,
        height: box.height,
        depth: box.depth,
        isBoundary: box.isBoundary,
      });
    }
    const text = nodeText(node);
    const headerWidth = Math.max(
      ...text.nameLines.map((line) => measureText(line, NAME_FONT_SIZE)),
      0,
    );
    return {
      node,
      width: Math.max(child.width + 2 * BOUNDARY_PADDING, Math.ceil(headerWidth) + 2 * BOUNDARY_PADDING, NODE_MIN_WIDTH),
      height: child.height + BOUNDARY_HEADER + BOUNDARY_PADDING,
      inner,
    };
  };

  /**
   * Lays out one sibling set and returns local coordinates. `scope` is the
   * parent id, used to decide which edges apply at this level.
   */
  const solve = (
    siblings: readonly ViewNode[],
    depth: number,
    scope: string | undefined,
  ): {
    positions: Map<string, { x: number; y: number; width: number; height: number; depth: number; isBoundary: boolean }>;
    width: number;
    height: number;
  } => {
    const sized = siblings.map((node) => sizeOf(node, depth));
    const ids = sized.map((s) => s.node.element.id).sort(compareIds);
    const index = new Map(ids.map((id, i) => [id, i]));

    // Which sibling, if any, contains this element?
    const anchor = (id: string): string | undefined => {
      let current: string | undefined = id;
      while (current !== undefined) {
        if (index.has(current)) return current;
        current = parentOf.get(current);
        if (current === scope) return undefined;
      }
      return undefined;
    };

    const adjacency = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
    for (const edge of view.edges) {
      const source = anchor(edge.sourceId);
      const dest = anchor(edge.destId);
      if (!source || !dest || source === dest) continue;
      adjacency.get(source)?.add(dest);
    }

    const layers = assignLayers(ids, adjacency);
    const ordered = orderWithinLayers(layers, adjacency, ids);

    const positions = new Map<string, { x: number; y: number; width: number; height: number; depth: number; isBoundary: boolean }>();
    const sizeById = new Map(sized.map((s) => [s.node.element.id, s]));

    // Cross-axis extent of each layer, then place layers along the main axis.
    let mainOffset = 0;
    let crossExtent = 0;
    const layerPlacements: { ids: string[]; mainSize: number; crossSize: number; mainStart: number }[] = [];

    for (const layerIds of ordered) {
      const mainSize = Math.max(
        ...layerIds.map((id) => mainSizeOf(sizeById.get(id), direction)),
        0,
      );
      const crossSize =
        layerIds.reduce((total, id) => total + crossSizeOf(sizeById.get(id), direction), 0) +
        Math.max(0, layerIds.length - 1) * nodeSep;
      layerPlacements.push({ ids: layerIds, mainSize, crossSize, mainStart: mainOffset });
      mainOffset += mainSize + layerSep;
      crossExtent = Math.max(crossExtent, crossSize);
    }
    const mainExtent = Math.max(0, mainOffset - layerSep);

    for (const placement of layerPlacements) {
      // Centre each layer on the cross axis so the drawing looks balanced.
      let cross = (crossExtent - placement.crossSize) / 2;
      for (const id of placement.ids) {
        const entry = sizeById.get(id);
        if (!entry) continue;
        const mainCentre = placement.mainStart + (placement.mainSize - mainSizeOf(entry, direction)) / 2;
        const x = direction === 'TB' ? cross : mainCentre;
        const y = direction === 'TB' ? mainCentre : cross;
        positions.set(id, {
          x: round(x),
          y: round(y),
          width: entry.width,
          height: entry.height,
          depth,
          isBoundary: entry.node.children.length > 0,
        });
        // Place this boundary's already-laid-out descendants.
        for (const [innerId, innerBox] of entry.inner) {
          positions.set(innerId, {
            x: round(x + innerBox.x),
            y: round(y + innerBox.y),
            width: innerBox.width,
            height: innerBox.height,
            depth: innerBox.depth,
            isBoundary: innerBox.isBoundary,
          });
        }
        cross += crossSizeOf(entry, direction) + nodeSep;
      }
    }

    return {
      positions,
      width: direction === 'TB' ? crossExtent : mainExtent,
      height: direction === 'TB' ? mainExtent : crossExtent,
    };
  };

  const root = solve(view.tree, 0, undefined);

  for (const [id, box] of root.positions) {
    boxes.set(id, {
      x: box.x + margin,
      y: box.y + margin,
      width: box.width,
      height: box.height,
      depth: box.depth,
      isBoundary: box.isBoundary,
      pinned: false,
    });
  }

  // Manual overrides win over the solver. Applying them after the fact is what
  // lets a model change reflow everything else without discarding the
  // positions a human chose to pin.
  //
  // Shallowest first: moving a boundary carries its children, so a pin on a
  // child must be applied after its parent has settled or it would be undone.
  const pinned = Object.entries(overrides)
    .filter(([id]) => boxes.has(id))
    .sort((a, b) => (boxes.get(a[0])?.depth ?? 0) - (boxes.get(b[0])?.depth ?? 0));

  for (const [id, position] of pinned) {
    const box = boxes.get(id);
    if (!box) continue;
    const dx = position.x - box.x;
    const dy = position.y - box.y;
    boxes.set(id, { ...box, x: position.x, y: position.y, pinned: true });
    // Move descendants with their boundary, or the drawing tears apart.
    for (const [otherId, other] of boxes) {
      if (otherId === id) continue;
      if (isDescendant(otherId, id, parentOf)) {
        boxes.set(otherId, { ...other, x: other.x + dx, y: other.y + dy });
      }
    }
  }

  /*
   * Containment is enforced here rather than trusted.
   *
   * A pin is just a number in a file: it can be stale, it can come from a
   * different model that happened to share a view name, or it can be the
   * result of a drag that went too far. None of those should be able to draw a
   * container floating outside the system that owns it — that is a picture
   * which contradicts the model, which is the one thing this tool exists to
   * prevent. So after all pins are applied, every child is clamped into its
   * parent's box, shallowest first so parents are final before children move.
   */
  const byDepth = [...boxes.entries()].sort((a, b) => a[1].depth - b[1].depth);
  for (const [id, box] of byDepth) {
    const parentId = parentOf.get(id);
    if (parentId === undefined) continue;
    const parent = boxes.get(parentId);
    if (!parent) continue;

    const minX = parent.x + BOUNDARY_PADDING / 2;
    const maxX = parent.x + parent.width - box.width - BOUNDARY_PADDING / 2;
    const minY = parent.y + BOUNDARY_HEADER;
    const maxY = parent.y + parent.height - box.height - BOUNDARY_PADDING / 2;

    const clampedX = maxX >= minX ? clamp(box.x, minX, maxX) : minX;
    const clampedY = maxY >= minY ? clamp(box.y, minY, maxY) : minY;
    if (clampedX === box.x && clampedY === box.y) continue;

    const dx = clampedX - box.x;
    const dy = clampedY - box.y;
    boxes.set(id, { ...box, x: round(clampedX), y: round(clampedY) });
    for (const [otherId, other] of boxes) {
      if (otherId === id) continue;
      if (isDescendant(otherId, id, parentOf)) {
        boxes.set(otherId, { ...other, x: round(other.x + dx), y: round(other.y + dy) });
      }
    }
  }

  const nodeBoxes: NodeBox[] = [...boxes.entries()]
    .map(([id, box]) => ({ id, ...box }))
    .sort((a, b) => a.depth - b.depth || compareIds(a.id, b.id));

  const edges = routeEdges(view, boxes, direction);

  const maxX = Math.max(...nodeBoxes.map((box) => box.x + box.width), 0);
  const maxY = Math.max(...nodeBoxes.map((box) => box.y + box.height), 0);
  const edgeMaxX = Math.max(...edges.flatMap((edge) => edge.points.map((point) => point.x)), 0);
  const edgeMaxY = Math.max(...edges.flatMap((edge) => edge.points.map((point) => point.y)), 0);

  return {
    viewId: view.id,
    direction,
    nodes: nodeBoxes,
    edges,
    width: round(Math.max(maxX, edgeMaxX) + margin),
    height: round(Math.max(maxY, edgeMaxY) + margin),
  };
}

// --------------------------------------------------------------------- layering

/**
 * Longest-path layering over the acyclic part of the graph. Back edges are
 * discovered by a DFS that visits nodes in id order, so which edge gets
 * classified as a back edge is a function of the model alone.
 */
function assignLayers(ids: readonly string[], adjacency: Map<string, Set<string>>): string[][] {
  const forward = new Map<string, string[]>();
  const onStack = new Set<string>();
  const visited = new Set<string>();

  const dfs = (id: string): void => {
    visited.add(id);
    onStack.add(id);
    const targets = [...(adjacency.get(id) ?? [])].sort(compareIds);
    const kept: string[] = [];
    for (const target of targets) {
      if (onStack.has(target)) continue; // back edge: drop for layering only
      kept.push(target);
      if (!visited.has(target)) dfs(target);
    }
    forward.set(id, kept);
    onStack.delete(id);
  };
  for (const id of ids) if (!visited.has(id)) dfs(id);

  const layerOf = new Map<string, number>();
  const compute = (id: string, guard: Set<string>): number => {
    const cached = layerOf.get(id);
    if (cached !== undefined) return cached;
    if (guard.has(id)) return 0;
    guard.add(id);
    let layer = 0;
    for (const [source, targets] of forward) {
      if (targets.includes(id)) {
        layer = Math.max(layer, compute(source, guard) + 1);
      }
    }
    guard.delete(id);
    layerOf.set(id, layer);
    return layer;
  };
  for (const id of ids) compute(id, new Set());

  const maxLayer = Math.max(...[...layerOf.values()], 0);
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const id of ids) {
    const layer = layerOf.get(id) ?? 0;
    (layers[layer] as string[]).push(id);
  }
  return layers.map((layerIds) => layerIds.sort(compareIds)).filter((layerIds) => layerIds.length > 0);
}

/**
 * Barycentre ordering, a fixed four passes down and up. Fixed iteration count
 * plus id tie-breaking makes the result reproducible; more passes would reduce
 * crossings slightly but no longer terminate identically on every input.
 */
function orderWithinLayers(
  layers: readonly string[][],
  adjacency: Map<string, Set<string>>,
  ids: readonly string[],
): string[][] {
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [source, targets] of adjacency) {
    for (const target of targets) incoming.get(target)?.push(source);
  }

  let current = layers.map((layer) => [...layer]);

  const positionsIn = (layer: readonly string[]): Map<string, number> =>
    new Map(layer.map((id, index) => [id, index]));

  for (let pass = 0; pass < 4; pass += 1) {
    const downward = pass % 2 === 0;
    const order = downward
      ? [...current.keys()].slice(1)
      : [...current.keys()].slice(0, -1).reverse();

    for (const layerIndex of order) {
      const reference = current[downward ? layerIndex - 1 : layerIndex + 1];
      const layer = current[layerIndex];
      if (!reference || !layer) continue;
      const referencePositions = positionsIn(reference);

      const scored = layer.map((id) => {
        const neighbours = downward ? (incoming.get(id) ?? []) : [...(adjacency.get(id) ?? [])];
        const relevant = neighbours
          .map((neighbour) => referencePositions.get(neighbour))
          .filter((value): value is number => value !== undefined);
        const barycentre =
          relevant.length === 0
            ? Number.POSITIVE_INFINITY
            : relevant.reduce((total, value) => total + value, 0) / relevant.length;
        return { id, barycentre };
      });

      // Nodes with no neighbour in the reference layer keep their relative
      // order at the end, sorted by id, rather than drifting arbitrarily.
      scored.sort((a, b) => {
        if (a.barycentre !== b.barycentre) return a.barycentre - b.barycentre;
        return compareIds(a.id, b.id);
      });
      current[layerIndex] = scored.map((entry) => entry.id);
    }
  }

  return current;
}

// ---------------------------------------------------------------------- routing

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Side = 'top' | 'bottom' | 'left' | 'right';

interface EdgePlan {
  id: string;
  sourceId: string;
  destId: string;
  source: Box;
  dest: Box;
  sourceSide: Side;
  destSide: Side;
  label: string | undefined;
}

/**
 * Routes every edge in one pass, distributing attachment points.
 *
 * Routing edges independently is what makes most generated diagrams hard to
 * read: each arrow attaches at the centre of a box side, so six arrows into one
 * service all converge on a single pixel and it becomes impossible to tell
 * which line goes where. Doing it globally lets the attachment points on a
 * given side be spread out and ordered by where the other end actually is,
 * which removes the pile-up and most of the crossings with it.
 *
 * Order is derived from geometry and broken by edge id, so the result stays
 * deterministic.
 */
function routeEdges(
  view: DerivedView,
  boxes: Map<string, { x: number; y: number; width: number; height: number }>,
  direction: Direction,
): EdgeRoute[] {
  const vertical = direction === 'TB';
  const plans: EdgePlan[] = [];

  for (const edge of view.edges) {
    const source = boxes.get(edge.sourceId);
    const dest = boxes.get(edge.destId);
    if (!source || !dest) continue;

    const sourceCentre = centreOf(source);
    const destCentre = centreOf(dest);

    let sourceSide: Side;
    let destSide: Side;

    if (vertical) {
      const gap = destCentre.y - sourceCentre.y;
      // "Same band" means the boxes overlap vertically, so a top/bottom route
      // would have to double back on itself; go out of the flanks instead.
      const sameBand = Math.abs(gap) < Math.max(source.height, dest.height) / 2 + 12;
      if (sameBand) {
        const rightwards = destCentre.x >= sourceCentre.x;
        sourceSide = rightwards ? 'right' : 'left';
        destSide = rightwards ? 'left' : 'right';
      } else {
        sourceSide = gap > 0 ? 'bottom' : 'top';
        destSide = gap > 0 ? 'top' : 'bottom';
      }
    } else {
      const gap = destCentre.x - sourceCentre.x;
      const sameBand = Math.abs(gap) < Math.max(source.width, dest.width) / 2 + 12;
      if (sameBand) {
        const downwards = destCentre.y >= sourceCentre.y;
        sourceSide = downwards ? 'bottom' : 'top';
        destSide = downwards ? 'top' : 'bottom';
      } else {
        sourceSide = gap > 0 ? 'right' : 'left';
        destSide = gap > 0 ? 'left' : 'right';
      }
    }

    plans.push({
      id: edge.id,
      sourceId: edge.sourceId,
      destId: edge.destId,
      source,
      dest,
      sourceSide,
      destSide,
      label: edgeLabelText(edge.description, edge.technology),
    });
  }

  // Group the attachments per node side so they can be spread out.
  const groups = new Map<string, { plan: EdgePlan; isSource: boolean }[]>();
  const push = (nodeId: string, side: Side, plan: EdgePlan, isSource: boolean): void => {
    const key = `${nodeId}|${side}`;
    const list = groups.get(key) ?? [];
    list.push({ plan, isSource });
    groups.set(key, list);
  };
  for (const plan of plans) {
    push(plan.sourceId, plan.sourceSide, plan, true);
    push(plan.destId, plan.destSide, plan, false);
  }

  /** Assigned attachment point per (edge, end). */
  const ports = new Map<string, { x: number; y: number }>();

  for (const [key, members] of [...groups].sort((a, b) => compareIds(a[0], b[0]))) {
    const [nodeId = '', sideText = 'top'] = key.split('|');
    const side = sideText as Side;
    const box = boxes.get(nodeId);
    if (!box) continue;
    const horizontalSide = side === 'top' || side === 'bottom';

    // Sort by where the *other* end sits along this side's axis, so lines do
    // not need to cross each other to reach their ports.
    members.sort((a, b) => {
      const other = (member: { plan: EdgePlan; isSource: boolean }): number => {
        const otherBox = member.isSource ? member.plan.dest : member.plan.source;
        const centre = centreOf(otherBox);
        return horizontalSide ? centre.x : centre.y;
      };
      const delta = other(a) - other(b);
      if (delta !== 0) return delta;
      return compareIds(a.plan.id, b.plan.id);
    });

    const span = horizontalSide ? box.width : box.height;
    // Keep ports off the rounded corners, and never let them collide.
    const inset = Math.min(22, span / 2 - 1);
    const usable = Math.max(0, span - inset * 2);
    const count = members.length;

    members.forEach((member, index) => {
      const fraction = count === 1 ? 0.5 : index / (count - 1);
      const along = inset + usable * fraction;
      const point = horizontalSide
        ? { x: box.x + along, y: side === 'top' ? box.y : box.y + box.height }
        : { x: side === 'left' ? box.x : box.x + box.width, y: box.y + along };
      ports.set(`${member.plan.id}|${member.isSource ? 'source' : 'dest'}`, {
        x: round(point.x),
        y: round(point.y),
      });
    });
  }

  const routes: EdgeRoute[] = [];

  for (const plan of plans) {
    const from = ports.get(`${plan.id}|source`);
    const to = ports.get(`${plan.id}|dest`);
    if (!from || !to) continue;

    const points = orthogonalPath(from, to, plan.sourceSide, plan.destSide);
    const label = labelAnchor(points);

    routes.push({
      id: plan.id,
      points,
      labelX: label.x,
      labelY: label.y,
      labelWidth: plan.label ? measureText(plan.label, EDGE_FONT_SIZE) : 0,
    });
  }

  return routes.sort((a, b) => compareIds(a.id, b.id));
}

/**
 * Builds an orthogonal polyline between two attachment points.
 *
 * A short stub leaves each side perpendicular to it, so an arrow always meets
 * a box at a right angle — the visual cue that says "this line ends here"
 * rather than "this line passes behind".
 */
function orthogonalPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  sourceSide: Side,
  destSide: Side,
): { x: number; y: number }[] {
  const STUB = 16;
  const start = stubFrom(from, sourceSide, STUB);
  const end = stubFrom(to, destSide, STUB);

  const points: { x: number; y: number }[] = [from, start];

  const sourceVertical = sourceSide === 'top' || sourceSide === 'bottom';
  const destVertical = destSide === 'top' || destSide === 'bottom';

  if (sourceVertical && destVertical) {
    const midY = round((start.y + end.y) / 2);
    if (start.x !== end.x) {
      points.push({ x: start.x, y: midY }, { x: end.x, y: midY });
    }
  } else if (!sourceVertical && !destVertical) {
    const midX = round((start.x + end.x) / 2);
    if (start.y !== end.y) {
      points.push({ x: midX, y: start.y }, { x: midX, y: end.y });
    }
  } else if (sourceVertical) {
    // Vertical out, horizontal in: one corner.
    points.push({ x: start.x, y: end.y });
  } else {
    points.push({ x: end.x, y: start.y });
  }

  points.push(end, to);

  // Collapse duplicate and collinear points so the path has no zero-length
  // segments, which would otherwise produce stray corner artefacts.
  return simplify(points);
}

function stubFrom(
  point: { x: number; y: number },
  side: Side,
  length: number,
): { x: number; y: number } {
  switch (side) {
    case 'top':
      return { x: point.x, y: round(point.y - length) };
    case 'bottom':
      return { x: point.x, y: round(point.y + length) };
    case 'left':
      return { x: round(point.x - length), y: point.y };
    case 'right':
      return { x: round(point.x + length), y: point.y };
  }
}

function simplify(points: readonly { x: number; y: number }[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && last.x === point.x && last.y === point.y) continue;
    out.push({ x: round(point.x), y: round(point.y) });
  }
  // Drop midpoints that lie on a straight line between their neighbours.
  const result: { x: number; y: number }[] = [];
  for (let i = 0; i < out.length; i += 1) {
    const previous = result[result.length - 1];
    const next = out[i + 1];
    const current = out[i] as { x: number; y: number };
    if (previous && next) {
      const collinearX = previous.x === current.x && current.x === next.x;
      const collinearY = previous.y === current.y && current.y === next.y;
      if (collinearX || collinearY) continue;
    }
    result.push(current);
  }
  return result;
}

/**
 * Places the label on the longest segment of the path, which is the one with
 * room for it and the one a reader's eye follows.
 */
function labelAnchor(points: readonly { x: number; y: number }[]): { x: number; y: number } {
  let best = { x: points[0]?.x ?? 0, y: points[0]?.y ?? 0 };
  let bestLength = -1;

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i] as { x: number; y: number };
    const b = points[i + 1] as { x: number; y: number };
    const length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (length > bestLength) {
      bestLength = length;
      best = { x: round((a.x + b.x) / 2), y: round((a.y + b.y) / 2) };
    }
  }
  return best;
}

function centreOf(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Mirrors the renderer's label text so measurement and drawing agree. */
function edgeLabelText(
  description: string | undefined,
  technology: string | undefined,
): string | undefined {
  const parts = [description, technology ? `[${technology}]` : undefined].filter(
    (value): value is string => value !== undefined && value.trim() !== '',
  );
  if (parts.length === 0) return undefined;
  return parts.join(' ');
}

// ------------------------------------------------------------------------ utils

function mainSizeOf(
  sized: { width: number; height: number } | undefined,
  direction: Direction,
): number {
  if (!sized) return 0;
  return direction === 'TB' ? sized.height : sized.width;
}

function crossSizeOf(
  sized: { width: number; height: number } | undefined,
  direction: Direction,
): number {
  if (!sized) return 0;
  return direction === 'TB' ? sized.width : sized.height;
}

function isDescendant(
  id: string,
  ancestorId: string,
  parentOf: Map<string, string | undefined>,
): boolean {
  let current = parentOf.get(id);
  while (current !== undefined) {
    if (current === ancestorId) return true;
    current = parentOf.get(current);
  }
  return false;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Integer geometry. Rounding at every step keeps float accumulation from
 * producing `120.00000000000001` on one platform and `120` on another, which
 * would make rendered SVG differ byte-for-byte between machines.
 */
function round(value: number): number {
  return Math.round(value);
}
