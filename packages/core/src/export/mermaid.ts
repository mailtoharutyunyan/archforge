/**
 * Mermaid export.
 *
 * Emits `flowchart` with subgraphs rather than Mermaid's own experimental
 * `C4Context` diagram: flowcharts render everywhere Mermaid is supported
 * (GitHub, GitLab, Notion, Obsidian, most static site generators), whereas the
 * C4 support is partial and varies by version. Interop is only useful if it
 * actually renders on the target.
 *
 * Dynamic views become `sequenceDiagram`, which is what they actually are.
 */

import type { Element } from '../model/types.ts';
import type { DerivedView } from '../views/views.ts';

export interface MermaidOptions {
  readonly direction?: 'TB' | 'LR';
  readonly showTechnology?: boolean;
}

export function toMermaid(view: DerivedView, options: MermaidOptions = {}): string {
  if (view.kind === 'dynamic') return toSequenceDiagram(view);

  const direction = options.direction ?? 'TB';
  const showTechnology = options.showTechnology ?? true;
  const lines: string[] = [];

  lines.push(`%% ${view.title} — generated from the architecture model, do not edit`);
  lines.push(`flowchart ${direction}`);

  const byParent = new Map<string | undefined, DerivedView['nodes'][number][]>();
  for (const node of view.nodes) {
    const parentId = node.element.parentId;
    const key =
      parentId && view.nodes.some((candidate) => candidate.element.id === parentId)
        ? parentId
        : undefined;
    const siblings = byParent.get(key) ?? [];
    siblings.push(node);
    byParent.set(key, siblings);
  }

  const emit = (parentId: string | undefined, indent: string): void => {
    for (const node of byParent.get(parentId) ?? []) {
      const element = node.element;
      const children = byParent.get(element.id) ?? [];
      if (children.length > 0) {
        lines.push(`${indent}subgraph ${id(element.id)}["${label(element, showTechnology)}"]`);
        lines.push(`${indent}  direction ${direction}`);
        emit(element.id, `${indent}  `);
        lines.push(`${indent}end`);
      } else {
        lines.push(`${indent}${shape(element, showTechnology)}`);
      }
    }
  };
  emit(undefined, '  ');

  for (const edge of view.edges) {
    const arrow = edge.direction === 'bi' ? '<-->' : '-->';
    const text = [edge.description, showTechnology && edge.technology ? `[${edge.technology}]` : '']
      .filter((part) => part && part.trim() !== '')
      .join(' ');
    lines.push(
      text
        ? `  ${id(edge.sourceId)} ${arrow}|"${escape(text)}"| ${id(edge.destId)}`
        : `  ${id(edge.sourceId)} ${arrow} ${id(edge.destId)}`,
    );
  }

  // Class definitions keep the palette consistent with our own renderer.
  lines.push('');
  lines.push('  classDef person fill:#4f46e5,stroke:none,color:#fff;');
  lines.push('  classDef system fill:#2563eb,stroke:none,color:#fff;');
  lines.push('  classDef container fill:#0891b2,stroke:none,color:#fff;');
  lines.push('  classDef component fill:#0284c7,stroke:none,color:#fff;');
  lines.push('  classDef database fill:#7c3aed,stroke:none,color:#fff;');
  lines.push('  classDef queue fill:#d97706,stroke:none,color:#fff;');
  lines.push('  classDef cache fill:#db2777,stroke:none,color:#fff;');
  lines.push('  classDef external fill:#64748b,stroke:none,color:#fff;');

  for (const node of view.nodes) {
    if ((byParent.get(node.element.id) ?? []).length > 0) continue;
    lines.push(`  class ${id(node.element.id)} ${classOf(node.element)};`);
  }

  return `${lines.join('\n')}\n`;
}

function toSequenceDiagram(view: DerivedView): string {
  const lines: string[] = [];
  lines.push(`%% ${view.title} — generated from the architecture model, do not edit`);
  lines.push('sequenceDiagram');
  lines.push('  autonumber');

  for (const node of view.nodes) {
    const keyword = node.element.kind === 'person' ? 'actor' : 'participant';
    lines.push(`  ${keyword} ${id(node.element.id)} as ${escape(node.element.name)}`);
  }
  for (const edge of view.edges) {
    const text = [edge.description, edge.technology ? `[${edge.technology}]` : '']
      .filter((part) => part && part.trim() !== '')
      .join(' ');
    lines.push(`  ${id(edge.sourceId)}->>${id(edge.destId)}: ${escape(text || 'calls')}`);
  }
  return `${lines.join('\n')}\n`;
}

function shape(element: Element, showTechnology: boolean): string {
  const text = `"${label(element, showTechnology)}"`;
  switch (element.subtype) {
    case 'database':
    case 'cache':
      return `${id(element.id)}[(${text})]`;
    case 'queue':
    case 'topic':
      return `${id(element.id)}[/${text}/]`;
    default:
      break;
  }
  if (element.kind === 'person') return `${id(element.id)}(${text})`;
  return `${id(element.id)}[${text}]`;
}

function label(element: Element, showTechnology: boolean): string {
  const parts = [escape(element.name)];
  const meta = showTechnology && element.technology ? element.technology : element.subtype;
  if (meta) parts.push(`<br/><small>[${escape(meta)}]</small>`);
  return parts.join('');
}

function classOf(element: Element): string {
  if (element.tags.includes('external')) return 'external';
  if (element.subtype === 'database' || element.subtype === 'cache') return element.subtype;
  if (element.subtype === 'queue' || element.subtype === 'topic') return 'queue';
  return element.kind === 'person' ? 'person' : element.kind;
}

/** Mermaid node ids must be alphanumeric-ish; dots and dashes break parsing. */
function id(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '_');
}

function escape(text: string): string {
  return text.replace(/"/g, '&quot;').replace(/\n/g, ' ');
}
