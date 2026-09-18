/**
 * PlantUML export.
 *
 * Two modes, and the default is deliberate:
 *
 *  - `standalone` (default): emits plain PlantUML with our own styling inlined
 *    at the top of the file. No `!include`, no external macro library, no
 *    network access, no third-party licence to honour. Every exported file is
 *    self-contained and renders in any PlantUML installation forever, even
 *    offline or in an air-gapped CI runner.
 *
 *  - `c4`: emits C4-PlantUML macro calls for teams already standardised on
 *    that library. Because that means depending on someone else's macros, the
 *    include location is *not* defaulted — the caller must supply it, ideally
 *    pointing at their own vendored copy.
 *
 * This is an interop target, not the rendering path. Nothing here is ever
 * parsed back; the model remains the source of truth.
 */

import type { ArchModel } from '../model/model.ts';
import type { Element } from '../model/types.ts';
import type { DerivedView } from '../views/views.ts';

export interface PlantUmlOptions {
  /**
   * `standalone` inlines our styling and depends on nothing. `c4` emits
   * C4-PlantUML macros and requires `includeBase`.
   */
  readonly style?: 'standalone' | 'c4';
  /**
   * Only used — and only required — when `style` is `c4`. Point it at your own
   * vendored copy of the macros, e.g. `assets/plantuml/c4`. Intentionally has
   * no default so that no generated file ever silently references a URL we do
   * not control.
   */
  readonly includeBase?: string;
  readonly direction?: 'TB' | 'LR';
  readonly showLegend?: boolean;
}

export function toPlantUml(
  model: ArchModel,
  view: DerivedView,
  options: PlantUmlOptions = {},
): string {
  const style = options.style ?? 'standalone';
  if (style === 'c4') {
    if (!options.includeBase) {
      throw new Error(
        'PlantUML C4 mode needs `includeBase` pointing at your own copy of the C4-PlantUML macros. ' +
          'Use the default `standalone` style for self-contained output with no external dependency.',
      );
    }
    return toC4PlantUml(view, options.includeBase, options.direction ?? 'TB');
  }
  return toStandalonePlantUml(model, view, options.direction ?? 'TB');
}

// ------------------------------------------------------------------ standalone

/**
 * Self-contained PlantUML. The palette mirrors the SVG renderer so a diagram
 * looks like the same product whichever path produced it.
 */
function toStandalonePlantUml(
  model: ArchModel,
  view: DerivedView,
  direction: 'TB' | 'LR',
): string {
  if (view.kind === 'dynamic') return toSequence(view);

  const lines: string[] = [];
  lines.push(`@startuml ${alias(view.id)}`);
  lines.push("' Generated from the architecture model — do not edit by hand.");
  lines.push("' Self-contained: no !include, no external macro library.");
  lines.push('');
  lines.push(...styleHeader(direction));
  lines.push('');
  lines.push(`title ${escapeText(view.title)}`);
  lines.push('');

  const byParent = groupByParent(view);

  const emit = (parentId: string | undefined, indent: string): void => {
    for (const node of byParent.get(parentId) ?? []) {
      const element = node.element;
      const children = byParent.get(element.id) ?? [];
      if (children.length > 0) {
        lines.push(
          `${indent}rectangle "${escapeText(element.name)}\\n<size:10><i>[${escapeText(
            element.subtype ?? element.kind,
          )}]</i></size>" as ${alias(element.id)} <<boundary>> {`,
        );
        emit(element.id, `${indent}  `);
        lines.push(`${indent}}`);
      } else {
        lines.push(`${indent}${declaration(element)}`);
      }
    }
  };
  emit(undefined, '');

  lines.push('');
  for (const edge of view.edges) {
    const arrow = edge.direction === 'bi' ? '<-->' : '-->';
    const label = edgeLabel(edge.description, edge.technology);
    lines.push(
      `${alias(edge.sourceId)} ${arrow} ${alias(edge.destId)}${label ? ` : ${label}` : ''}`,
    );
  }

  lines.push('');
  lines.push('@enduml');
  void model;
  return `${lines.join('\n')}\n`;
}

/**
 * Our styling, inlined. Kept as data rather than a vendored `.puml` include so
 * that a single generated file is the complete artefact.
 */
function styleHeader(direction: 'TB' | 'LR'): string[] {
  return [
    direction === 'LR' ? 'left to right direction' : 'top to bottom direction',
    'skinparam backgroundColor #FFFFFF',
    'skinparam defaultFontName "Helvetica Neue"',
    'skinparam defaultFontSize 12',
    'skinparam shadowing false',
    'skinparam roundCorner 10',
    'skinparam ArrowColor #94A3B8',
    'skinparam ArrowFontColor #64748B',
    'skinparam ArrowFontSize 11',
    'skinparam padding 3',
    'skinparam nodesep 40',
    'skinparam ranksep 50',
    '',
    'skinparam rectangle {',
    '  BorderColor #2563EB',
    '  BackgroundColor #2563EB',
    '  FontColor #FFFFFF',
    '  BorderColor<<boundary>> #CBD5E1',
    '  BackgroundColor<<boundary>> #F8FAFC',
    '  FontColor<<boundary>> #475569',
    '  BorderColor<<container>> #0891B2',
    '  BackgroundColor<<container>> #0891B2',
    '  BorderColor<<component>> #0284C7',
    '  BackgroundColor<<component>> #0284C7',
    '  BorderColor<<api>> #0D9488',
    '  BackgroundColor<<api>> #0D9488',
    '  BorderColor<<external>> #64748B',
    '  BackgroundColor<<external>> #64748B',
    '  BorderColor<<node>> #475569',
    '  BackgroundColor<<node>> #E2E8F0',
    '  FontColor<<node>> #0F172A',
    '}',
    'skinparam database {',
    '  BorderColor #7C3AED',
    '  BackgroundColor #7C3AED',
    '  FontColor #FFFFFF',
    '}',
    'skinparam queue {',
    '  BorderColor #D97706',
    '  BackgroundColor #D97706',
    '  FontColor #FFFFFF',
    '}',
    'skinparam actor {',
    '  BorderColor #4F46E5',
    '  BackgroundColor #4F46E5',
    '  FontColor #0F172A',
    '}',
  ];
}

/**
 * Chooses a PlantUML primitive per element. Uses `database`/`queue`/`actor`
 * where PlantUML has a native shape, and stereotyped rectangles otherwise, so
 * subtypes survive without needing a macro library.
 */
function declaration(element: Element): string {
  const label = elementLabel(element);
  const id = alias(element.id);
  const external = element.tags.includes('external');

  if (element.kind === 'person') return `actor "${label}" as ${id}`;

  switch (element.subtype) {
    case 'database':
    case 'cache':
      return `database "${label}" as ${id}`;
    case 'queue':
    case 'topic':
      return `queue "${label}" as ${id}`;
    default:
      break;
  }

  if (element.kind === 'deploymentNode' || element.kind === 'infrastructureNode') {
    return `rectangle "${label}" as ${id} <<node>>`;
  }

  const stereotype = external ? 'external' : element.subtype === 'api' ? 'api' : element.kind;
  return `rectangle "${label}" as ${id} <<${stereotype}>>`;
}

function elementLabel(element: Element): string {
  const parts = [`<b>${escapeText(element.name)}</b>`];
  const meta = element.technology ?? element.subtype ?? element.kind;
  parts.push(`<size:10>[${escapeText(meta)}]</size>`);
  if (element.description) {
    parts.push(`<size:10><i>${escapeText(truncate(element.description, 60))}</i></size>`);
  }
  return parts.join('\\n');
}

function toSequence(view: DerivedView): string {
  const lines: string[] = [];
  lines.push(`@startuml ${alias(view.id)}`);
  lines.push("' Generated from the architecture model — do not edit by hand.");
  lines.push('skinparam backgroundColor #FFFFFF');
  lines.push('skinparam defaultFontName "Helvetica Neue"');
  lines.push('skinparam shadowing false');
  lines.push('skinparam sequenceArrowColor #64748B');
  lines.push('skinparam sequenceParticipantBackgroundColor #2563EB');
  lines.push('skinparam sequenceParticipantFontColor #FFFFFF');
  lines.push('skinparam sequenceParticipantBorderColor #2563EB');
  lines.push('autonumber');
  lines.push('');
  lines.push(`title ${escapeText(view.title)}`);
  lines.push('');

  for (const node of view.nodes) {
    const keyword = node.element.kind === 'person' ? 'actor' : 'participant';
    lines.push(`${keyword} "${escapeText(node.element.name)}" as ${alias(node.element.id)}`);
  }
  lines.push('');
  for (const edge of view.edges) {
    const label = [edge.description, edge.technology ? `[${edge.technology}]` : '']
      .filter((part) => part && part.trim() !== '')
      .join(' ');
    lines.push(
      `${alias(edge.sourceId)} -> ${alias(edge.destId)} : ${escapeText(label || 'calls')}`,
    );
  }
  lines.push('');
  lines.push('@enduml');
  return `${lines.join('\n')}\n`;
}

// -------------------------------------------------------------------- c4 mode

/**
 * C4-PlantUML macro output, for teams already invested in that library.
 * `includeBase` is supplied by the caller — we never bake in a location.
 */
function toC4PlantUml(view: DerivedView, includeBase: string, direction: 'TB' | 'LR'): string {
  const macroFile =
    view.kind === 'context'
      ? 'C4_Context.puml'
      : view.kind === 'container'
        ? 'C4_Container.puml'
        : view.kind === 'component'
          ? 'C4_Component.puml'
          : view.kind === 'deployment'
            ? 'C4_Deployment.puml'
            : 'C4_Dynamic.puml';

  const lines: string[] = [];
  lines.push(`@startuml ${alias(view.id)}`);
  lines.push(`!include ${includeBase.replace(/\/+$/, '')}/${macroFile}`);
  lines.push('');
  lines.push(direction === 'LR' ? 'LAYOUT_LEFT_RIGHT()' : 'LAYOUT_TOP_DOWN()');
  lines.push('');
  lines.push(`title ${escapeText(view.title)}`);
  lines.push('');

  const byParent = groupByParent(view);
  const emit = (parentId: string | undefined, indent: string): void => {
    for (const node of byParent.get(parentId) ?? []) {
      const element = node.element;
      const children = byParent.get(element.id) ?? [];
      if (children.length > 0) {
        const macro = element.kind === 'container' ? 'Container_Boundary' : 'System_Boundary';
        lines.push(
          `${indent}${macro}(${alias(element.id)}, "${escapeText(element.name)}") {`,
        );
        emit(element.id, `${indent}  `);
        lines.push(`${indent}}`);
      } else {
        lines.push(`${indent}${c4Macro(element)}`);
      }
    }
  };
  emit(undefined, '');

  lines.push('');
  for (const edge of view.edges) {
    const macro = edge.direction === 'bi' ? 'BiRel' : 'Rel';
    lines.push(
      `${macro}(${alias(edge.sourceId)}, ${alias(edge.destId)}, "${escapeText(
        edge.description ?? '',
      )}"${edge.technology ? `, "${escapeText(edge.technology)}"` : ''})`,
    );
  }
  lines.push('');
  lines.push('@enduml');
  return `${lines.join('\n')}\n`;
}

function c4Macro(element: Element): string {
  const id = alias(element.id);
  const name = escapeText(element.name);
  const technology = escapeText(element.technology ?? '');
  const description = escapeText(element.description ?? '');
  const ext = element.tags.includes('external') ? '_Ext' : '';

  switch (element.kind) {
    case 'person':
      return `Person${ext}(${id}, "${name}", "${description}")`;
    case 'system':
      return `System${ext}(${id}, "${name}", "${description}")`;
    case 'container':
      if (element.subtype === 'database' || element.subtype === 'cache') {
        return `ContainerDb${ext}(${id}, "${name}", "${technology}", "${description}")`;
      }
      if (element.subtype === 'queue' || element.subtype === 'topic') {
        return `ContainerQueue${ext}(${id}, "${name}", "${technology}", "${description}")`;
      }
      return `Container${ext}(${id}, "${name}", "${technology}", "${description}")`;
    case 'component':
      if (element.subtype === 'database' || element.subtype === 'cache') {
        return `ComponentDb${ext}(${id}, "${name}", "${technology}", "${description}")`;
      }
      return `Component${ext}(${id}, "${name}", "${technology}", "${description}")`;
    case 'deploymentNode':
      return `Deployment_Node(${id}, "${name}", "${technology}", "${description}")`;
    case 'infrastructureNode':
      return `Container(${id}, "${name}", "${technology}", "${description}")`;
  }
}

// ---------------------------------------------------------------------- shared

function groupByParent(view: DerivedView): Map<string | undefined, DerivedView['nodes'][number][]> {
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
  return byParent;
}

function edgeLabel(description: string | undefined, technology: string | undefined): string {
  const parts = [description, technology ? `<size:10>[${technology}]</size>` : '']
    .filter((part) => part && part.trim() !== '')
    .map((part) => escapeText(part as string));
  return parts.join('\\n');
}

/** PlantUML aliases cannot contain dots, so ids are flattened predictably. */
function alias(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, '_');
}

function escapeText(text: string): string {
  return text.replace(/"/g, "''").replace(/\n/g, '\\n');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
