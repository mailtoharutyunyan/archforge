/**
 * SVG renderer.
 *
 * Three constraints shape everything here:
 *
 *  1. Deterministic. No timestamps, no random ids, no locale-dependent number
 *     formatting, no iteration over unsorted maps. The same model renders to
 *     the same bytes, which is what makes a diagram reviewable in a diff.
 *  2. Not coupled to a DOM. The output is a string, built the same way in Node
 *     and in the browser, so the CLI and the web editor cannot disagree.
 *  3. Addressable. Every node and edge carries `data-arch-id`, so the web
 *     editor gets hit-testing, selection and dragging for free instead of
 *     needing a second, parallel rendering path.
 *
 * Both themes ship in one file via CSS custom properties, so a single exported
 * SVG works on a light page, a dark page, and in a `prefers-color-scheme`
 * context, without re-rendering.
 */

import type { Element } from '../model/types.ts';
import type { DerivedView, ViewEdge, ViewNode } from '../views/views.ts';
import {
  BOUNDARY_HEADER,
  EDGE_FONT_SIZE,
  ICON_GLYPH,
  ICON_GUTTER,
  ICON_TILE,
  META_FONT_SIZE,
  NAME_FONT_SIZE,
  NODE_PADDING,
  nodeText,
  type Layout,
  type NodeBox,
} from '../layout/layered.ts';
import { escapeXml, measureText, truncateText } from '../util/text.ts';
import { iconFor } from './icon-policy.ts';
import type { IconDef } from './icons.ts';

export interface RenderOptions {
  /** `auto` emits both palettes and follows the viewer's preference. */
  readonly theme?: 'light' | 'dark' | 'auto';
  readonly showLegend?: boolean;
  readonly showTitle?: boolean;
  readonly showIcons?: boolean;
  /** Emits `data-*` hooks and cursor styles used by the interactive editor. */
  readonly interactive?: boolean;
  /**
   * Faint bands behind the diagram marking dependency depth. On by default:
   * they carry information a background grid does not.
   */
  readonly showLayers?: boolean;
  /**
   * Paint the diagram's own background rectangle. On for exports, where the
   * SVG is the whole artefact. Off in the editor: there the diagram sits on the
   * application's canvas, and painting its own surface makes it look like a
   * small picture floating in a large empty window rather than a drawing on a
   * work surface.
   */
  readonly showBackground?: boolean;
  /** Included in the accessible description. */
  readonly workspaceName?: string;
}

interface LayerBand {
  readonly start: number;
  readonly size: number;
  readonly index: number;
}

/**
 * Derives depth bands from the laid-out top-level nodes.
 *
 * Only depth-0 boxes participate: nested elements are positioned inside their
 * boundary and would otherwise split a band in half. Boxes whose extents touch
 * are merged, so a band is "everything at roughly this depth" rather than one
 * band per node.
 */
function computeLayerBands(layout: Layout): LayerBand[] {
  const roots = layout.nodes.filter((box) => box.depth === 0);
  if (roots.length < 2) return [];

  const isVertical = layout.direction === 'TB';
  const extents = roots
    .map((box) => ({
      from: isVertical ? box.y : box.x,
      to: isVertical ? box.y + box.height : box.x + box.width,
    }))
    .sort((a, b) => a.from - b.from);

  const merged: { from: number; to: number }[] = [];
  for (const extent of extents) {
    const last = merged[merged.length - 1];
    // A 12px tolerance keeps nodes that are visually in the same row together
    // even when their heights differ slightly.
    if (last && extent.from <= last.to + 12) {
      last.to = Math.max(last.to, extent.to);
    } else {
      merged.push({ ...extent });
    }
  }

  if (merged.length < 2) return [];
  return merged.map((band, index) => ({
    start: band.from,
    size: band.to - band.from,
    index,
  }));
}

const CORNER = 10;

export function renderSvg(
  view: DerivedView,
  layout: Layout,
  options: RenderOptions = {},
): string {
  const theme = options.theme ?? 'auto';
  const showTitle = options.showTitle ?? true;
  const showLegend = options.showLegend ?? false;
  const showIcons = options.showIcons ?? true;
  const interactive = options.interactive ?? false;

  const nodesById = new Map(view.nodes.map((node) => [node.element.id, node]));
  const boxesById = new Map(layout.nodes.map((box) => [box.id, box]));

  const headerHeight = showTitle ? 58 : 0;
  const legendEntries = showLegend ? legendFor(view) : [];
  const legendHeight = legendEntries.length > 0 ? 44 : 0;
  const width = Math.max(layout.width, 360);
  const height = layout.height + headerHeight + legendHeight;

  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
      `class="arch arch-theme-${theme}" role="img" aria-labelledby="arch-title arch-desc">`,
  );
  parts.push(`<title id="arch-title">${escapeXml(view.title)}</title>`);
  parts.push(
    `<desc id="arch-desc">${escapeXml(describeView(view, options.workspaceName))}</desc>`,
  );
  parts.push(styleBlock(theme, interactive));
  parts.push(defsBlock());
  if (options.showBackground ?? true) {
    parts.push(`<rect class="arch-bg" x="0" y="0" width="${width}" height="${height}"/>`);
  }

  if (showTitle) {
    parts.push(
      `<text class="arch-view-title" x="${20}" y="${30}">${escapeXml(view.title)}</text>`,
    );
    parts.push(
      `<text class="arch-view-subtitle" x="${20}" y="${47}">${escapeXml(
        `${view.kind} view · ${view.nodes.length} elements · ${view.edges.length} relationships`,
      )}</text>`,
    );
  }

  const offsetY = headerHeight;
  parts.push(`<g transform="translate(0 ${offsetY})">`);

  // Dependency-depth separators.
  //
  // A square grid behind a canvas is decoration — it says nothing about the
  // drawing. These lines are computed from the layout's own layering, so the
  // background states something true: crossing one is crossing a dependency
  // boundary.
  //
  // This started as filled bands, which read as broken striping on a real
  // diagram. Hairlines carry the same information and disappear when you are
  // not looking for them, which is the correct weight for background structure.
  if (options.showLayers ?? true) {
    const bands = computeLayerBands(layout);
    const isVertical = layout.direction === 'TB';
    for (const band of bands.slice(1)) {
      const at = band.start - 24;
      parts.push(
        isVertical
          ? `<line class="arch-layer-rule" x1="16" y1="${at}" x2="${width - 16}" y2="${at}"/>`
          : `<line class="arch-layer-rule" x1="${at}" y1="16" x2="${at}" y2="${layout.height - 16}"/>`,
      );
    }
  }

  // Boundaries first (shallowest to deepest), so leaves always draw on top.
  const boundaries = layout.nodes.filter((box) => box.isBoundary);
  const leaves = layout.nodes.filter((box) => !box.isBoundary);

  for (const box of boundaries) {
    const node = nodesById.get(box.id);
    if (node) parts.push(renderBoundary(node, box, showIcons, interactive));
  }

  // Painting order is deliberate, in three passes:
  //   1. boundaries   — the backdrop
  //   2. edge lines   — above boundaries so a connection is never hidden by a
  //                     boundary fill, below nodes so a line appears to end at
  //                     a box rather than run across it
  //   3. nodes, then edge labels last
  //
  // Labels go last because they are the part a reader needs most and the part
  // most easily lost: drawn with their lines, they disappear behind any node
  // the line passes near.
  const routesById = new Map(layout.edges.map((route) => [route.id, route]));

  for (const edge of view.edges) {
    const route = routesById.get(edge.id);
    if (route) parts.push(renderEdgeLine(edge, route, interactive));
  }

  for (const box of leaves) {
    const node = nodesById.get(box.id);
    if (node) parts.push(renderNode(node, box, showIcons, interactive));
  }

  // Suppress labels that would land on top of one another. Two overlapping
  // labels are less informative than one, because neither can be read.
  const placed: { x: number; y: number; width: number }[] = [];
  const obstacles = leaves.map((box) => ({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
  }));
  for (const edge of view.edges) {
    const route = routesById.get(edge.id);
    if (!route) continue;
    const markup = renderEdgeLabel(edge, route, placed, obstacles);
    if (markup) parts.push(markup);
  }

  parts.push('</g>');

  if (legendEntries.length > 0) {
    parts.push(renderLegend(legendEntries, 20, offsetY + layout.height + 16));
  }

  void boxesById;
  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}

// ------------------------------------------------------------------------ nodes

function renderNode(
  node: ViewNode,
  box: NodeBox,
  showIcons: boolean,
  interactive: boolean,
): string {
  const element = node.element;
  const text = nodeText(node);
  const classes = ['arch-node', `arch-kind-${cssToken(element.kind)}`];
  if (element.subtype) classes.push(`arch-sub-${cssToken(element.subtype)}`);
  if (element.tags.includes('external')) classes.push('arch-external');
  if (element.provenance.source === 'inferred') classes.push('arch-inferred');

  const parts: string[] = [];
  parts.push(
    `<g class="${classes.join(' ')}"${dataAttributes(element, interactive)} ` +
      `transform="translate(${box.x} ${box.y})">`,
  );
  parts.push(
    `<rect class="arch-node-shape" x="0" y="0" width="${box.width}" height="${box.height}" ` +
      `rx="${CORNER}" ry="${CORNER}"/>`,
  );

  // A person gets a head-and-shoulders cue rather than a plain box, because at
  // a glance the actor row is the thing readers look for first.
  if (element.kind === 'person') {
    parts.push(
      `<circle class="arch-person-head" cx="${box.width / 2}" cy="-11" r="11"/>`,
    );
  }

  const padding = NODE_PADDING;
  const icon = showIcons ? iconFor(element) : undefined;
  const textX = icon ? padding + ICON_GUTTER : padding;
  const textWidth = box.width - textX - padding;

  // The icon tile. A light plate behind the logo is what lets a full-colour
  // brand mark stay legible on top of a saturated node fill — without it,
  // a dark logo on a dark node simply disappears.
  if (icon) {
    parts.push(
      `<rect class="arch-icon-tile" x="${padding}" y="${padding}" ` +
        `width="${ICON_TILE}" height="${ICON_TILE}" rx="11" ry="11"/>`,
    );
    parts.push(
      iconGlyph(
        icon,
        padding + (ICON_TILE - ICON_GLYPH) / 2,
        padding + (ICON_TILE - ICON_GLYPH) / 2,
      ),
    );
  }

  // Text block, vertically centred against the tile when it is short.
  const lineCount = text.nameLines.length + text.technologyLines.length + text.descriptionLines.length;
  const blockHeight = text.nameLines.length * 17 + text.technologyLines.length * 15 + text.descriptionLines.length * 15;
  const startY =
    lineCount <= 2
      ? padding + (ICON_TILE - blockHeight) / 2 + NAME_FONT_SIZE - 1
      : padding + NAME_FONT_SIZE;
  let cursorY = Math.round(startY);

  for (const line of text.nameLines) {
    parts.push(
      `<text class="arch-node-name" x="${textX}" y="${cursorY}">${escapeXml(
        truncateText(line, NAME_FONT_SIZE, textWidth),
      )}</text>`,
    );
    cursorY += 17;
  }

  cursorY += 1;
  for (const line of text.technologyLines) {
    parts.push(
      `<text class="arch-node-meta" x="${textX}" y="${cursorY}">${escapeXml(
        truncateText(line, META_FONT_SIZE, textWidth),
      )}</text>`,
    );
    cursorY += 15;
  }

  for (const line of text.descriptionLines) {
    parts.push(
      `<text class="arch-node-desc" x="${textX}" y="${cursorY}">${escapeXml(
        truncateText(line, META_FONT_SIZE, textWidth),
      )}</text>`,
    );
    cursorY += 15;
  }

  if (element.owner) {
    parts.push(
      `<text class="arch-node-owner" x="${box.width - padding}" y="${box.height - 9}" ` +
        `text-anchor="end">${escapeXml(truncateText(element.owner, 9, 100))}</text>`,
    );
  }

  parts.push('</g>');
  return parts.join('\n');
}

/**
 * Places a vendored icon at a position, sized to `ICON_GLYPH`.
 *
 * Uses a nested `<svg>` with the icon's own viewBox rather than a `<g>` with a
 * scale transform. That matters for correctness, not tidiness: many real icons
 * are filled with `userSpaceOnUse` gradients, whose coordinates are resolved
 * against the current user space. Re-scaling that space with a transform moves
 * the gradient off the shape and the icon renders invisible — which is exactly
 * what happened to the Node.js logo. A nested `<svg>` establishes a fresh
 * coordinate system, so the gradient lands where its author intended.
 *
 * Monochrome packs inherit the plate's ink colour; full-colour packs keep their
 * own fills untouched.
 */
function iconGlyph(icon: IconDef, x: number, y: number): string {
  const classes = ['arch-icon', icon.monochrome ? 'arch-icon-mono' : 'arch-icon-colour'];

  return (
    `<svg class="${classes.join(' ')}" x="${round(x)}" y="${round(y)}" ` +
    `width="${ICON_GLYPH}" height="${ICON_GLYPH}" viewBox="${escapeXml(icon.viewBox)}" ` +
    `overflow="visible" aria-hidden="true">${icon.body}</svg>`
  );
}

function renderBoundary(
  node: ViewNode,
  box: NodeBox,
  showIcons: boolean,
  interactive: boolean,
): string {
  const element = node.element;
  const classes = ['arch-boundary', `arch-kind-${cssToken(element.kind)}`];
  if (element.tags.includes('external')) classes.push('arch-external');

  const parts: string[] = [];
  parts.push(
    `<g class="${classes.join(' ')}"${dataAttributes(element, interactive)} ` +
      `transform="translate(${box.x} ${box.y})">`,
  );
  parts.push(
    `<rect class="arch-boundary-shape" x="0" y="0" width="${box.width}" height="${box.height}" ` +
      `rx="${CORNER + 4}" ry="${CORNER + 4}"/>`,
  );
  parts.push(
    `<text class="arch-boundary-name" x="16" y="${BOUNDARY_HEADER - 12}">${escapeXml(
      truncateText(element.name, NAME_FONT_SIZE, box.width - 60),
    )}</text>`,
  );
  const subtitle = `[${element.subtype ?? element.kind}]`;
  parts.push(
    `<text class="arch-boundary-meta" x="${box.width - 14}" y="${BOUNDARY_HEADER - 12}" ` +
      `text-anchor="end">${escapeXml(subtitle)}</text>`,
  );
  // Boundaries deliberately carry no icon: the containers inside them already
  // show their technologies, and a mark on the frame competes with them.
  void showIcons;
  parts.push('</g>');
  return parts.join('\n');
}

// ------------------------------------------------------------------------ edges

/** The line and arrowheads only. Labels are drawn in a later pass. */
function renderEdgeLine(
  edge: ViewEdge,
  route: { points: readonly { x: number; y: number }[] },
  interactive: boolean,
): string {
  if (route.points.length < 2) return '';

  const classes = ['arch-edge'];
  if (edge.lifted) classes.push('arch-edge-lifted');
  if (edge.direction === 'bi') classes.push('arch-edge-bi');
  for (const tag of edge.tags) classes.push(`arch-edge-tag-${cssToken(tag)}`);

  const path = roundedPath(route.points, 8);
  const marker = edge.direction === 'bi' ? ' marker-start="url(#arch-arrow-start)"' : '';

  const parts: string[] = [];
  parts.push(
    `<g class="${classes.join(' ')}"${
      interactive ? ` data-arch-edge="${escapeXml(edge.id)}"` : ''
    }>`,
  );
  // A wide transparent stroke under the visible line gives the web editor a
  // comfortable click target without changing the drawing.
  if (interactive) {
    parts.push(`<path class="arch-edge-hit" d="${path}"/>`);
  }
  parts.push(
    `<path class="arch-edge-line" d="${path}" marker-end="url(#arch-arrow)"${marker}/>`,
  );
  parts.push('</g>');
  return parts.join('\n');
}

/**
 * The label for an edge, drawn above everything else.
 *
 * Returns an empty result when the label would overlap one already placed:
 * two labels on top of each other are strictly worse than one, since neither
 * can be read and the reader cannot tell which line either belongs to.
 */
function renderEdgeLabel(
  edge: ViewEdge,
  route: { labelX: number; labelY: number; points: readonly { x: number; y: number }[] },
  placed: { x: number; y: number; width: number }[],
  obstacles: readonly { x: number; y: number; width: number; height: number }[],
): string | undefined {
  const label = edgeLabel(edge);
  if (!label) return undefined;

  const width = measureText(label, EDGE_FONT_SIZE) + 12;
  const HALF_HEIGHT = 9;

  const clashesWithNode = (x: number, y: number): boolean =>
    obstacles.some(
      (box) =>
        x + width / 2 > box.x &&
        x - width / 2 < box.x + box.width &&
        y + HALF_HEIGHT > box.y &&
        y - HALF_HEIGHT < box.y + box.height,
    );

  const clashesWithLabel = (x: number, y: number): boolean =>
    placed.some(
      (other) =>
        Math.abs(other.y - y) < 16 && Math.abs(other.x - x) < (other.width + width) / 2 + 4,
    );

  // Candidate anchors: the default, then the midpoint of every segment from
  // longest to shortest, then points a third and two thirds along the longest
  // segment. A label that cannot be placed clear of both the boxes and the
  // other labels is dropped rather than printed on top of something.
  const candidates: { x: number; y: number }[] = [{ x: route.labelX, y: route.labelY }];

  const segments = route.points
    .slice(0, -1)
    .map((point, index) => {
      const next = route.points[index + 1] as { x: number; y: number };
      return {
        a: point,
        b: next,
        length: Math.abs(next.x - point.x) + Math.abs(next.y - point.y),
      };
    })
    .sort((left, right) => right.length - left.length);

  for (const segment of segments) {
    for (const fraction of [0.5, 0.35, 0.65]) {
      candidates.push({
        x: round(segment.a.x + (segment.b.x - segment.a.x) * fraction),
        y: round(segment.a.y + (segment.b.y - segment.a.y) * fraction),
      });
    }
  }

  const anchor = candidates.find(
    (point) => !clashesWithNode(point.x, point.y) && !clashesWithLabel(point.x, point.y),
  );
  if (!anchor) return undefined;

  placed.push({ x: anchor.x, y: anchor.y, width });

  const parts: string[] = ['<g class="arch-edge-label-group">'];
  parts.push(
    `<rect class="arch-edge-label-bg" x="${round(anchor.x - width / 2)}" ` +
      `y="${round(anchor.y - HALF_HEIGHT)}" width="${round(width)}" height="18" rx="5" ry="5"/>`,
  );
  parts.push(
    `<text class="arch-edge-label" x="${anchor.x}" y="${anchor.y + 4}" ` +
      `text-anchor="middle">${escapeXml(label)}</text>`,
  );
  if (edge.order !== undefined) {
    parts.push(
      `<circle class="arch-step-badge" cx="${round(anchor.x - width / 2 - 11)}" cy="${anchor.y}" r="9"/>`,
    );
    parts.push(
      `<text class="arch-step-number" x="${round(anchor.x - width / 2 - 11)}" y="${anchor.y + 3.5}" ` +
        `text-anchor="middle">${edge.order}</text>`,
    );
  }
  parts.push('</g>');
  return parts.join('\n');
}

function edgeLabel(edge: ViewEdge): string | undefined {
  const parts = [edge.description, edge.technology ? `[${edge.technology}]` : undefined].filter(
    (value): value is string => value !== undefined && value.trim() !== '',
  );
  if (parts.length === 0) return undefined;
  const label = parts.join(' ');
  return label.length > 52 ? `${label.slice(0, 51)}…` : label;
}

/** Polyline with rounded corners, emitted with integer coordinates only. */
function roundedPath(points: readonly { x: number; y: number }[], radius: number): string {
  if (points.length < 2) return '';
  const first = points[0] as { x: number; y: number };
  const segments: string[] = [`M ${round(first.x)} ${round(first.y)}`];

  for (let i = 1; i < points.length - 1; i += 1) {
    const previous = points[i - 1] as { x: number; y: number };
    const current = points[i] as { x: number; y: number };
    const next = points[i + 1] as { x: number; y: number };

    const inLength = distance(previous, current);
    const outLength = distance(current, next);
    const r = Math.min(radius, inLength / 2, outLength / 2);
    if (r < 1) {
      segments.push(`L ${round(current.x)} ${round(current.y)}`);
      continue;
    }
    const entry = along(current, previous, r);
    const exit = along(current, next, r);
    segments.push(`L ${round(entry.x)} ${round(entry.y)}`);
    segments.push(`Q ${round(current.x)} ${round(current.y)} ${round(exit.x)} ${round(exit.y)}`);
  }

  const last = points[points.length - 1] as { x: number; y: number };
  segments.push(`L ${round(last.x)} ${round(last.y)}`);
  return segments.join(' ');
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function along(
  from: { x: number; y: number },
  towards: { x: number; y: number },
  length: number,
): { x: number; y: number } {
  const total = distance(from, towards) || 1;
  return {
    x: from.x + ((towards.x - from.x) * length) / total,
    y: from.y + ((towards.y - from.y) * length) / total,
  };
}

// ----------------------------------------------------------------------- legend

interface LegendEntry {
  readonly label: string;
  readonly className: string;
}

function legendFor(view: DerivedView): LegendEntry[] {
  const seen = new Map<string, LegendEntry>();
  for (const node of view.nodes) {
    const key = node.element.subtype ?? node.element.kind;
    if (seen.has(key)) continue;
    seen.set(key, {
      label: key,
      className: `arch-kind-${cssToken(node.element.kind)} arch-sub-${cssToken(key)}`,
    });
  }
  return [...seen.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

function renderLegend(entries: readonly LegendEntry[], x: number, y: number): string {
  const parts: string[] = ['<g class="arch-legend">'];
  let cursorX = x;
  for (const entry of entries) {
    parts.push(
      `<g class="${entry.className}" transform="translate(${round(cursorX)} ${round(y)})">` +
        `<rect class="arch-legend-swatch" x="0" y="0" width="12" height="12" rx="3" ry="3"/>` +
        `<text class="arch-legend-label" x="18" y="10">${escapeXml(entry.label)}</text></g>`,
    );
    cursorX += 30 + measureText(entry.label, 11);
  }
  parts.push('</g>');
  return parts.join('\n');
}

// ------------------------------------------------------------------ chrome, css

function defsBlock(): string {
  return [
    '<defs>',
    '<marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">',
    '<path class="arch-arrow-head" d="M 0 0 L 10 5 L 0 10 z"/>',
    '</marker>',
    '<marker id="arch-arrow-start" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">',
    '<path class="arch-arrow-head" d="M 10 0 L 0 5 L 10 10 z"/>',
    '</marker>',
    '</defs>',
  ].join('\n');
}

/**
 * Both palettes are emitted as custom properties. `auto` wires the dark values
 * to `prefers-color-scheme`, so one exported file reads correctly on a light
 * page, a dark page, and in a viewer that follows the OS setting.
 */
function styleBlock(theme: 'light' | 'dark' | 'auto', interactive: boolean): string {
  const light = `
    --bg: #ffffff;
    --surface: #ffffff;
    --ink: #0f172a;
    --ink-muted: #64748b;
    --line: #94a3b8;
    --boundary-stroke: #cbd5e1;
    --boundary-fill: #f8fafc;
    --boundary-ink: #475569;
    --shadow: rgba(15, 23, 42, 0.10);
    --person: #4f46e5;
    --system: #2563eb;
    --container: #0891b2;
    --component: #0284c7;
    --database: #7c3aed;
    --queue: #d97706;
    --topic: #ca8a04;
    --cache: #db2777;
    --api: #0d9488;
    --node-ink: #ffffff;
    --external: #64748b;
    --layer: #0f172a;`;

  const dark = `
    --bg: #0b1120;
    --surface: #111a2e;
    --ink: #e2e8f0;
    --ink-muted: #94a3b8;
    --line: #64748b;
    --boundary-stroke: #334155;
    --boundary-fill: #0f172a;
    --boundary-ink: #94a3b8;
    --shadow: rgba(0, 0, 0, 0.45);
    --person: #818cf8;
    --system: #60a5fa;
    --container: #22d3ee;
    --component: #38bdf8;
    --database: #a78bfa;
    --queue: #fbbf24;
    --topic: #facc15;
    --cache: #f472b6;
    --api: #2dd4bf;
    --node-ink: #06121f;
    --external: #94a3b8;
    --layer: #cbd5e1;`;

  const palette =
    theme === 'dark'
      ? `.arch {${dark}}`
      : theme === 'light'
        ? `.arch {${light}}`
        : `.arch {${light}}\n@media (prefers-color-scheme: dark) { .arch {${dark}} }`;

  return `<style>
${palette}
.arch { font-family: ui-sans-serif, -apple-system, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif; }
.arch-bg { fill: var(--bg); }

/* Depth separators. Near the threshold of visibility on purpose: structure
   when you look for it, invisible when you don't. */
.arch-layer-rule {
  stroke: var(--layer);
  stroke-width: 1;
  opacity: 0.16;
  stroke-dasharray: 2 7;
}
.arch-view-title { fill: var(--ink); font-size: 17px; font-weight: 650; }
.arch-view-subtitle { fill: var(--ink-muted); font-size: 11px; }

.arch-boundary-shape {
  fill: var(--boundary-fill);
  stroke: var(--boundary-stroke);
  stroke-width: 1.5;
  stroke-dasharray: 7 5;
}
/* The boundary title names the system the reader is inside; at 13px muted it
   was the least legible text on the diagram despite being the most orienting. */
.arch-boundary-name {
  fill: var(--ink);
  font-size: 14px;
  font-weight: 660;
  letter-spacing: -0.01em;
}
.arch-boundary-meta { fill: var(--boundary-ink); font-size: 10px; opacity: 0.75; }

.arch-node-shape {
  fill: var(--system);
  stroke: none;
  filter: drop-shadow(0 1px 2px var(--shadow));
}
.arch-kind-person .arch-node-shape { fill: var(--person); }
.arch-kind-container .arch-node-shape { fill: var(--container); }
.arch-kind-component .arch-node-shape { fill: var(--component); }
.arch-kind-deploymentNode .arch-node-shape,
.arch-kind-infrastructureNode .arch-node-shape { fill: var(--external); }
.arch-sub-database .arch-node-shape { fill: var(--database); }
.arch-sub-cache .arch-node-shape { fill: var(--cache); }
.arch-sub-queue .arch-node-shape { fill: var(--queue); }
.arch-sub-topic .arch-node-shape { fill: var(--topic); }
.arch-sub-api .arch-node-shape { fill: var(--api); }
.arch-external .arch-node-shape { fill: var(--external); }
.arch-person-head { fill: var(--person); }

.arch-node-name { fill: var(--node-ink); font-size: 14px; font-weight: 620; }
.arch-node-meta { fill: var(--node-ink); font-size: 11px; opacity: 0.82; }
.arch-node-desc { fill: var(--node-ink); font-size: 11px; opacity: 0.72; }
.arch-node-owner { fill: var(--node-ink); font-size: 9px; opacity: 0.6; letter-spacing: 0.04em; }

/* Inferred elements are visually distinct from declared ones, on purpose:
   a reader must never mistake what a scanner guessed for what a human wrote. */
.arch-inferred .arch-node-shape { stroke: var(--node-ink); stroke-width: 1.5; stroke-dasharray: 5 4; }

.arch-edge-line { fill: none; stroke: var(--line); stroke-width: 1.6; }
/* Lifted edges were dashed, which made almost every line on a container view
   dashed — the distinction stopped being information and just read as busy.
   A slightly lighter stroke says the same thing without the noise. */
.arch-edge-lifted .arch-edge-line { opacity: 0.7; }
.arch-edge-tag-async .arch-edge-line { stroke-dasharray: 7 5; }
.arch-arrow-head { fill: var(--line); }
.arch-edge-label { fill: var(--ink-muted); font-size: 11px; }
/* Labels are painted over nodes, so the chip has to be fully opaque and
   outlined — a translucent plate over a saturated node is unreadable. */
.arch-edge-label-bg {
  fill: var(--bg);
  stroke: var(--boundary-stroke);
  stroke-width: 1;
}
.arch-edge-label-group { pointer-events: none; }
.arch-step-badge { fill: var(--system); }
.arch-step-number { fill: var(--node-ink); font-size: 10px; font-weight: 700; }

/* The plate behind an icon: near-white so full-colour brand marks read against
   a saturated node, and so monochrome marks have something to sit on. */
.arch-icon-tile { fill: #ffffff; opacity: 0.94; }
.arch-external .arch-icon-tile { opacity: 0.88; }

.arch-icon { pointer-events: none; }
/* Monochrome packs are single-path silhouettes; tint them to the node colour
   family rather than leaving them black on white. */
.arch-icon-mono { color: #0f172a; }
.arch-icon-mono path, .arch-icon-mono circle, .arch-icon-mono rect, .arch-icon-mono polygon {
  fill: currentColor;
}
.arch-icon-mono [stroke] { stroke: currentColor; }

.arch-legend-swatch { fill: var(--system); }
.arch-legend-label { fill: var(--ink-muted); font-size: 11px; }
${
  interactive
    ? `
.arch-edge-hit { fill: none; stroke: transparent; stroke-width: 14; pointer-events: stroke; }
.arch-node, .arch-boundary { cursor: grab; }
/* Selection reads as a focus ring in the accent colour rather than a heavy
   black outline, which on a saturated node looked like a rendering fault. */
.arch-node.is-selected .arch-node-shape {
  stroke: #0ea5e9;
  stroke-width: 3;
  paint-order: stroke;
}
.arch-boundary.is-selected .arch-boundary-shape {
  stroke: #0ea5e9;
  stroke-width: 2;
  stroke-dasharray: none;
}
.arch-node.is-dimmed, .arch-edge.is-dimmed, .arch-boundary.is-dimmed { opacity: 0.22; }`
    : ''
}
</style>`;
}

function dataAttributes(element: Element, interactive: boolean): string {
  if (!interactive) return ` data-arch-id="${escapeXml(element.id)}"`;
  return (
    ` data-arch-id="${escapeXml(element.id)}"` +
    ` data-arch-kind="${escapeXml(element.kind)}"` +
    (element.subtype ? ` data-arch-subtype="${escapeXml(element.subtype)}"` : '') +
    ` data-arch-provenance="${element.provenance.source}"`
  );
}

function describeView(view: DerivedView, workspaceName: string | undefined): string {
  const scope = view.scopeId ? ` of ${view.scopeId}` : '';
  const prefix = workspaceName ? `${workspaceName}: ` : '';
  return (
    `${prefix}${view.kind} view${scope}. ` +
    `${view.nodes.length} elements: ${view.nodes.map((node) => node.element.name).join(', ')}. ` +
    `${view.edges.length} relationships.`
  );
}

/** CSS-safe token. Deterministic and collision-free for our identifier shapes. */
function cssToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-');
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
