/**
 * PlantUML (C4-PlantUML style) -> Archforge model.
 *
 * The migration path. People already have C4-PlantUML diagrams, and telling
 * them to retype everything into a new DSL is how a tool gets ignored. This
 * reads the macros C4-PlantUML and our own `assets/plantuml` library define and
 * produces a real model, which can then be rendered, linted, diffed and drift
 * checked like any other.
 *
 * Two design decisions worth stating:
 *
 *  1. Structure is repaired, not assumed. A PlantUML diagram frequently
 *     declares a `Container` with no enclosing boundary, which is meaningless
 *     in C4 and invalid in our model. The importer synthesises the missing
 *     system or container and *reports what it added* as a diagnostic, so the
 *     user can see the assumption rather than discover it later.
 *  2. Unrecognised lines are counted and reported, never silently dropped. An
 *     importer that quietly loses half a diagram is worse than one that
 *     refuses, because the loss is invisible.
 */

import { diag, type Diagnostic } from '../diagnostics.ts';
import type {
  Element,
  ElementKind,
  Relation,
  SourceLoc,
  ViewDef,
  Workspace,
} from '../model/types.ts';
import { normalizeTags, slug, sortBy } from '../util/canonical.ts';

export interface ImportResult {
  readonly workspace: Workspace;
  readonly diagnostics: readonly Diagnostic[];
  readonly stats: {
    readonly elements: number;
    readonly relationships: number;
    /** Lines that looked like content but were not understood. */
    readonly skipped: number;
    /** Structure the importer had to invent to produce a valid model. */
    readonly synthesized: number;
  };
}

/**
 * True when the text is PlantUML rather than our DSL.
 *
 * Used to turn "83 syntax errors" into one actionable message. Deliberately
 * cheap and conservative: `@startuml` is decisive, and so is a C4 element
 * macro call, which our grammar has no way to produce.
 */
export function looksLikePlantUml(text: string): boolean {
  const head = text.slice(0, 4000);
  if (/^\s*@startuml/m.test(head)) return true;
  if (/^\s*!include(?:url)?\s/m.test(head)) return true;
  if (/^\s*(?:Person|System|Container|Component)(?:_Ext|Db|Queue|Api)?\s*\(/m.test(head)) {
    return true;
  }
  if (/^\s*(?:Rel|BiRel|RelIndex)(?:_Back|_U|_D|_L|_R|_Async)?\s*\(/m.test(head)) return true;
  return false;
}

/** What each element macro means. `subtype` is our open taxonomy. */
interface MacroSpec {
  readonly kind: ElementKind;
  readonly subtype?: string;
  readonly external?: boolean;
  /** Argument order after the alias: `label` is always first. */
  readonly shape: 'labelDescr' | 'labelTechDescr' | 'labelTypeDescr';
}

const ELEMENT_MACROS: Readonly<Record<string, MacroSpec>> = {
  Person: { kind: 'person', shape: 'labelDescr' },
  Person_Ext: { kind: 'person', external: true, shape: 'labelDescr' },

  System: { kind: 'system', shape: 'labelDescr' },
  System_Ext: { kind: 'system', external: true, shape: 'labelDescr' },
  SystemDb: { kind: 'system', subtype: 'database', shape: 'labelDescr' },
  SystemDb_Ext: { kind: 'system', subtype: 'database', external: true, shape: 'labelDescr' },
  SystemQueue: { kind: 'system', subtype: 'queue', shape: 'labelDescr' },
  SystemQueue_Ext: { kind: 'system', subtype: 'queue', external: true, shape: 'labelDescr' },

  Container: { kind: 'container', shape: 'labelTechDescr' },
  Container_Ext: { kind: 'container', external: true, shape: 'labelTechDescr' },
  ContainerApi: { kind: 'container', subtype: 'api', shape: 'labelTechDescr' },
  ContainerDb: { kind: 'container', subtype: 'database', shape: 'labelTechDescr' },
  ContainerDb_Ext: {
    kind: 'container',
    subtype: 'database',
    external: true,
    shape: 'labelTechDescr',
  },
  ContainerCache: { kind: 'container', subtype: 'cache', shape: 'labelTechDescr' },
  ContainerQueue: { kind: 'container', subtype: 'queue', shape: 'labelTechDescr' },
  ContainerQueue_Ext: {
    kind: 'container',
    subtype: 'queue',
    external: true,
    shape: 'labelTechDescr',
  },
  ContainerTopic: { kind: 'container', subtype: 'topic', shape: 'labelTechDescr' },
  ContainerBrowser: { kind: 'container', subtype: 'browser', shape: 'labelTechDescr' },
  ContainerMobile: { kind: 'container', subtype: 'mobileApp', shape: 'labelTechDescr' },
  ContainerFunction: { kind: 'container', subtype: 'function', shape: 'labelTechDescr' },

  Component: { kind: 'component', shape: 'labelTechDescr' },
  Component_Ext: { kind: 'component', external: true, shape: 'labelTechDescr' },
  ComponentApi: { kind: 'component', subtype: 'api', shape: 'labelTechDescr' },
  ComponentDb: { kind: 'component', subtype: 'database', shape: 'labelTechDescr' },
  ComponentQueue: { kind: 'component', subtype: 'queue', shape: 'labelTechDescr' },
  ComponentService: { kind: 'component', subtype: 'service', shape: 'labelTechDescr' },

  Deployment_Node: { kind: 'deploymentNode', shape: 'labelTypeDescr' },
  Node: { kind: 'deploymentNode', shape: 'labelTypeDescr' },
  Node_L: { kind: 'deploymentNode', shape: 'labelTypeDescr' },
  Node_R: { kind: 'deploymentNode', shape: 'labelTypeDescr' },
  Infrastructure_Node: { kind: 'infrastructureNode', shape: 'labelTypeDescr' },
};

/** Boundary macros and the `type` they imply. */
const BOUNDARY_MACROS: Readonly<Record<string, string>> = {
  Boundary: '',
  System_Boundary: 'system',
  Container_Boundary: 'container',
  Enterprise_Boundary: 'enterprise',
};

const RELATION_MACROS: ReadonlySet<string> = new Set([
  'Rel',
  'Rel_Back',
  'Rel_Neighbor',
  'Rel_Back_Neighbor',
  'Rel_U',
  'Rel_Up',
  'Rel_D',
  'Rel_Down',
  'Rel_L',
  'Rel_Left',
  'Rel_R',
  'Rel_Right',
  'Rel_Async',
  'RelIndex',
  'RelIndex_Back',
  'BiRel',
  'BiRel_U',
  'BiRel_D',
  'BiRel_L',
  'BiRel_R',
]);

/** Directives and styling that carry no model information. */
const IGNORED_PREFIXES: readonly string[] = [
  '@startuml',
  '@enduml',
  '@startc4',
  '@endc4',
  '!include',
  '!includeurl',
  '!define',
  '!definelong',
  '!procedure',
  '!endprocedure',
  '!function',
  '!endfunction',
  '!return',
  '!if',
  '!else',
  '!elseif',
  '!endif',
  '!theme',
  '!pragma',
  '!log',
  '!assume',
  '!$',
  'skinparam',
  'skin ',
  'hide ',
  'show ',
  'scale ',
  'legend',
  'endlegend',
  'header',
  'endheader',
  'footer',
  'caption',
  'top to bottom',
  'left to right',
  'AddElementTag',
  'AddRelTag',
  'AddBoundaryTag',
  'UpdateElementStyle',
  'UpdateRelStyle',
  'UpdateBoundaryStyle',
  'UpdateLayoutConfig',
  'LAYOUT_',
  'SHOW_LEGEND',
  'SHOW_FLOATING_LEGEND',
  'HIDE_STEREOTYPE',
  'SET_',
  'WithoutPropertyHeader',
  'AddProperty',
  'SetPropertyHeader',
  'EndPropertyHeader',
  'Lay_',
  'ResetIndex',
  'SetIndex',
  'together',
  'sprite',
  'note ',
  'end note',
];

export function importPlantUml(text: string, file = 'diagram.puml'): ImportResult {
  const diagnostics: Diagnostic[] = [];
  const elements = new Map<string, Element>();
  const relations: Relation[] = [];
  /** PlantUML alias -> our element id. */
  const aliasToId = new Map<string, string>();
  const boundaryStack: { id: string | undefined; synthetic: boolean }[] = [];
  const usedLocalIds = new Set<string>();

  let workspaceName = 'Imported architecture';
  let skipped = 0;
  let synthesized = 0;

  const lines = text.split(/\r?\n/);

  /** A unique, valid local identifier derived from a PlantUML alias. */
  const localIdFor = (alias: string, parentId: string | undefined): string => {
    let base = alias.replace(/[^A-Za-z0-9_-]/g, '');
    if (base === '' || /^[0-9-]/.test(base)) base = `e${base}`;
    let candidate = base;
    let n = 2;
    while (usedLocalIds.has(`${parentId ?? ''}.${candidate}`)) {
      candidate = `${base}${n}`;
      n += 1;
    }
    usedLocalIds.add(`${parentId ?? ''}.${candidate}`);
    return candidate;
  };

  const addElement = (
    alias: string,
    spec: MacroSpec,
    values: { label: string; technology?: string; description?: string },
    parentId: string | undefined,
    loc: SourceLoc,
  ): string => {
    const localId = localIdFor(alias, parentId);
    const id = parentId ? `${parentId}.${localId}` : localId;

    elements.set(id, {
      id,
      localId,
      kind: spec.kind,
      subtype: spec.subtype,
      name: values.label || localId,
      description: values.description,
      technology: values.technology,
      tags: normalizeTags(spec.external ? ['external', 'imported'] : ['imported']),
      properties: {},
      parentId,
      provenance: { source: 'declared', loc },
    });
    aliasToId.set(alias, id);
    return id;
  };

  /**
   * Ensures a parent exists that can legally contain `kind`, creating one if
   * the diagram did not provide it. C4-PlantUML does not require the nesting
   * our model does, so this is the common case rather than an edge case.
   */
  const ensureParentFor = (kind: ElementKind, loc: SourceLoc): string | undefined => {
    const current = boundaryStack[boundaryStack.length - 1]?.id;
    const currentKind = current ? elements.get(current)?.kind : undefined;

    if (kind === 'person' || kind === 'system') return undefined;

    if (kind === 'deploymentNode') {
      return currentKind === 'deploymentNode' ? current : undefined;
    }
    if (kind === 'infrastructureNode') {
      if (currentKind === 'deploymentNode') return current;
      const host = synthesize('deploymentNode', 'Deployment', undefined, loc);
      return host;
    }
    if (kind === 'container') {
      if (currentKind === 'system') return current;
      if (currentKind === 'container') return current;
      return synthesize('system', workspaceName, undefined, loc);
    }
    // component
    if (currentKind === 'container') return current;
    if (currentKind === 'system') {
      return synthesize('container', 'Application', current, loc);
    }
    const system = synthesize('system', workspaceName, undefined, loc);
    return synthesize('container', 'Application', system, loc);
  };

  /** Creates a wrapper element and records that it was invented. */
  const synthesize = (
    kind: ElementKind,
    name: string,
    parentId: string | undefined,
    loc: SourceLoc,
  ): string => {
    const key = `${kind}|${parentId ?? ''}`;
    const existing = [...elements.values()].find(
      (element) =>
        element.kind === kind &&
        element.parentId === parentId &&
        element.tags.includes('synthesized'),
    );
    if (existing) return existing.id;

    const localId = localIdFor(slug(name).replace(/-/g, '') || kind, parentId);
    const id = parentId ? `${parentId}.${localId}` : localId;
    elements.set(id, {
      id,
      localId,
      kind,
      name,
      description: 'Added by the PlantUML importer so the model is structurally valid.',
      tags: normalizeTags(['imported', 'synthesized']),
      properties: {},
      parentId,
      provenance: { source: 'declared', loc },
    });
    synthesized += 1;
    diagnostics.push(
      diag(
        'info',
        'import/synthesized-parent',
        `Added a ${kind} "${name}" because the diagram declared elements without one.`,
        loc,
        'C4-PlantUML does not require the nesting the model does. Rename or restructure it as you like.',
      ),
    );
    void key;
    return id;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] as string;
    const line = raw.trim();
    const loc: SourceLoc = { file, line: index + 1, column: 1 };

    if (line === '') continue;
    // PlantUML comments start with a single quote.
    if (line.startsWith("'") || line.startsWith('/*') || line.startsWith('*')) continue;

    if (line === '}' || line === '},') {
      boundaryStack.pop();
      continue;
    }

    if (/^title\s+/i.test(line)) {
      workspaceName = line.replace(/^title\s+/i, '').trim() || workspaceName;
      continue;
    }

    if (IGNORED_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;

    const call = /^([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)$/.exec(line);
    if (!call) {
      // A bare `alias --> other : label` arrow is also a relationship.
      const arrow = /^(\S+)\s*(<--?->?|--+>|\.\.+>|<--+|-+)\s*(\S+)\s*(?::\s*(.*))?$/.exec(line);
      if (arrow) {
        recordRelation(arrow[1] ?? '', arrow[3] ?? '', arrow[4] ?? '', '', loc);
        continue;
      }
      skipped += 1;
      diagnostics.push(
        diag('warning', 'import/unrecognised-line', `Ignored: ${truncate(line, 60)}`, loc),
      );
      continue;
    }

    const macro = call[1] as string;
    const openBrace = line.endsWith('{');
    const args = parseArgs(stripTrailingBrace(call[2] ?? ''));

    if (BOUNDARY_MACROS[macro] !== undefined) {
      const alias = args.positional[0] ?? '';
      const label = args.positional[1] ?? alias;
      const type = BOUNDARY_MACROS[macro] || args.positional[2] || '';

      // A container boundary is a container; everything else is a system.
      const kind: ElementKind = type === 'container' ? 'container' : 'system';
      const parentId =
        kind === 'container'
          ? (ensureParentFor('container', loc) ?? undefined)
          : undefined;
      const id = addElement(
        alias,
        { kind, shape: 'labelDescr' },
        { label },
        parentId,
        loc,
      );
      if (openBrace) boundaryStack.push({ id, synthetic: false });
      continue;
    }

    const spec = ELEMENT_MACROS[macro];
    if (spec) {
      const alias = args.positional[0] ?? '';
      const label = args.positional[1] ?? alias;
      let technology: string | undefined;
      let description: string | undefined;

      if (spec.shape === 'labelDescr') {
        description = args.positional[2];
      } else {
        technology = args.positional[2];
        description = args.positional[3];
      }

      const parentId = ensureParentFor(spec.kind, loc);
      const id = addElement(
        alias,
        spec,
        { label, technology: blankToUndefined(technology), description: blankToUndefined(description) },
        parentId,
        loc,
      );
      // `Deployment_Node(...) {` nests.
      if (openBrace) boundaryStack.push({ id, synthetic: false });
      continue;
    }

    if (RELATION_MACROS.has(macro)) {
      recordRelation(
        args.positional[0] ?? '',
        args.positional[1] ?? '',
        args.positional[2] ?? '',
        args.positional[3] ?? '',
        loc,
        macro.startsWith('BiRel'),
        macro.endsWith('_Back'),
      );
      continue;
    }

    // An unknown macro that opens a block still has to be balanced, or every
    // subsequent element would be nested in the wrong place.
    if (openBrace) {
      boundaryStack.push({ id: boundaryStack[boundaryStack.length - 1]?.id, synthetic: true });
    }
    skipped += 1;
    diagnostics.push(
      diag('warning', 'import/unknown-macro', `Unsupported macro \`${macro}\`.`, loc),
    );
  }

  function recordRelation(
    fromAlias: string,
    toAlias: string,
    label: string,
    technology: string,
    loc: SourceLoc,
    bidirectional = false,
    back = false,
  ): void {
    const fromId = aliasToId.get(fromAlias);
    const toId = aliasToId.get(toAlias);

    if (!fromId || !toId) {
      skipped += 1;
      diagnostics.push(
        diag(
          'warning',
          'import/unknown-endpoint',
          `Skipped a relationship: ${!fromId ? fromAlias : toAlias} was never declared.`,
          loc,
        ),
      );
      return;
    }
    if (fromId === toId) return;

    const sourceId = back ? toId : fromId;
    const destId = back ? fromId : toId;
    const id = `${sourceId}->${destId}`;
    if (relations.some((relation) => relation.id === id)) return;

    relations.push({
      id,
      sourceId,
      destId,
      description: blankToUndefined(label),
      technology: blankToUndefined(technology),
      direction: bidirectional ? 'bi' : 'uni',
      tags: ['imported'],
      properties: {},
      provenance: { source: 'declared', loc },
    });
  }

  // A view per top-level system, plus a landscape, so the import is immediately
  // viewable rather than a model with nothing to look at.
  const views: ViewDef[] = [];
  const systems = [...elements.values()].filter(
    (element) => element.kind === 'system' && element.parentId === undefined,
  );
  const primary = systems.find((system) => !system.tags.includes('external')) ?? systems[0];

  if (primary) {
    views.push({
      id: 'landscape',
      kind: 'context',
      title: `${workspaceName} — landscape`,
      scopeId: primary.id,
      include: [],
      exclude: [],
      steps: [],
    });
    for (const system of systems) {
      const hasContainers = [...elements.values()].some(
        (element) => element.parentId === system.id && element.kind === 'container',
      );
      if (!hasContainers) continue;
      views.push({
        id: `${system.localId}-containers`,
        kind: 'container',
        title: `${system.name} — containers`,
        scopeId: system.id,
        include: [],
        exclude: [],
        steps: [],
      });
    }
  }

  for (const container of [...elements.values()].filter((e) => e.kind === 'container')) {
    const hasComponents = [...elements.values()].some(
      (element) => element.parentId === container.id && element.kind === 'component',
    );
    if (!hasComponents) continue;
    views.push({
      id: `${container.localId}-components`,
      kind: 'component',
      title: `${container.name} — components`,
      scopeId: container.id,
      include: [],
      exclude: [],
      steps: [],
    });
  }

  const deploymentRoots = [...elements.values()].filter(
    (element) => element.kind === 'deploymentNode' && element.parentId === undefined,
  );
  for (const root of deploymentRoots) {
    views.push({
      id: `${root.localId}-deployment`,
      kind: 'deployment',
      title: `${root.name} — deployment`,
      scopeId: root.id,
      include: [],
      exclude: [],
      steps: [],
    });
  }

  if (elements.size === 0) {
    diagnostics.push(
      diag(
        'error',
        'import/nothing-found',
        'No C4 elements were found in this file.',
        { file, line: 1, column: 1 },
        'The importer understands C4-PlantUML macros such as Person(), System(), Container() and Rel().',
      ),
    );
  }

  return {
    workspace: {
      name: workspaceName,
      description:
        'Imported from PlantUML. Every element is tagged `imported`; elements tagged ' +
        '`synthesized` were added to make the structure valid. Review, then delete the tags.',
      elements: sortBy([...elements.values()], (element) => element.id),
      relations: sortBy(relations, (relation) => relation.id),
      views,
      rules: [],
      properties: { importedFrom: file },
    },
    diagnostics,
    stats: {
      elements: elements.size,
      relationships: relations.length,
      skipped,
      synthesized,
    },
  };
}

/**
 * Splits a macro argument list.
 *
 * Handles quoted strings containing commas and parentheses, `$name=value`
 * named arguments (which C4-PlantUML uses for tags, sprites and links and
 * which carry no structure we need), and a trailing `)`.
 */
function parseArgs(input: string): { positional: string[]; named: Record<string, string> } {
  const positional: string[] = [];
  const named: Record<string, string> = {};

  let current = '';
  let depth = 0;
  let inString = false;
  let quote = '"';

  const flush = (): void => {
    const value = current.trim();
    current = '';
    if (value === '') {
      positional.push('');
      return;
    }
    const namedMatch = /^\$?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/.exec(value);
    if (namedMatch) {
      named[namedMatch[1] as string] = unquote(namedMatch[2] as string);
      return;
    }
    positional.push(unquote(value));
  };

  for (let i = 0; i < input.length; i += 1) {
    const character = input[i] as string;

    if (inString) {
      if (character === '\\') {
        current += character + (input[i + 1] ?? '');
        i += 1;
        continue;
      }
      if (character === quote) inString = false;
      current += character;
      continue;
    }

    if (character === '"' || character === "'") {
      inString = true;
      quote = character;
      current += character;
      continue;
    }
    if (character === '(') {
      depth += 1;
      current += character;
      continue;
    }
    if (character === ')') {
      if (depth === 0) break; // closing paren of the macro call
      depth -= 1;
      current += character;
      continue;
    }
    if (character === ',' && depth === 0) {
      flush();
      continue;
    }
    current += character;
  }
  if (current.trim() !== '' || positional.length === 0) flush();

  return { positional, named };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\n/g, ' ')
        .replace(/<br\s*\/?>/gi, ' ')
        .trim();
    }
  }
  return trimmed.replace(/\\n/g, ' ').replace(/<br\s*\/?>/gi, ' ').trim();
}

function stripTrailingBrace(input: string): string {
  return input.replace(/\{\s*$/, '');
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
