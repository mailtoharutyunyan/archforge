/**
 * Workspace -> DSL source.
 *
 * The inverse of the compiler, and the reason `arch analyze` and the browser's
 * "analyse folder" can hand you something you then *own*: a readable `.arch`
 * file you edit by hand, rather than a generated artefact you have to keep
 * regenerating.
 *
 * Output is canonical — elements and relationships in stable order, consistent
 * indentation — so re-emitting an unchanged model produces identical bytes and
 * a regeneration shows up as an empty diff.
 */

import type { ArchModel } from '../model/model.ts';
import type { Element, Relation, RuleDef, ViewDef, Workspace } from '../model/types.ts';
import { compareIds } from '../util/canonical.ts';

export interface EmitOptions {
  /** Emit `// SOURCE: inferred ...` banners above inferred elements. */
  readonly annotateProvenance?: boolean;
  readonly indent?: string;
}

/** Keyword to use for an element, preferring the sugar form where it exists. */
const SUGAR_KEYWORDS = new Set([
  'database',
  'queue',
  'topic',
  'cache',
  'api',
  'service',
  'browser',
  'mobileApp',
  'function',
]);

export function emitWorkspace(model: ArchModel, options: EmitOptions = {}): string {
  const indentUnit = options.indent ?? '  ';
  const annotate = options.annotateProvenance ?? true;
  const workspace = model.workspace;
  const lines: string[] = [];

  const push = (depth: number, text: string): void => {
    lines.push(text === '' ? '' : `${indentUnit.repeat(depth)}${text}`);
  };

  push(0, `workspace ${quote(workspace.name)} {`);
  if (workspace.description) {
    push(1, emitDescription(workspace.description, indentUnit, 1));
  }
  for (const key of Object.keys(workspace.properties).sort()) {
    push(1, `prop ${key} ${quote(workspace.properties[key] ?? '')}`);
  }
  push(0, '');

  // Elements, parents before children, in stable id order.
  const emitElement = (element: Element, depth: number): void => {
    if (annotate && element.provenance.source === 'inferred') {
      push(
        depth,
        `// SOURCE: inferred by ${element.provenance.detector} · CONFIDENCE: ${element.provenance.confidence}`,
      );
      const first = element.provenance.evidence[0];
      if (first) push(depth, `// EVIDENCE: ${first.file}:${first.line}`);
    }

    const keyword = keywordFor(element);
    const header = `${keyword} ${element.localId} ${quote(element.name)}`;
    const body: string[] = [];

    if (element.description) body.push(emitDescription(element.description, indentUnit, depth + 1));
    if (element.technology) body.push(`technology ${quote(element.technology)}`);
    // Only emit a subtype the keyword does not already imply.
    if (element.subtype && !SUGAR_KEYWORDS.has(keyword)) body.push(`kind ${element.subtype}`);
    if (element.owner && element.owner !== inheritedOwner(model, element)) {
      body.push(`owner ${quote(element.owner)}`);
    }
    if (element.url) body.push(`url ${quote(element.url)}`);
    if (element.sourcePath) body.push(`source ${quote(element.sourcePath)}`);
    if (element.instanceOf) body.push(`instanceOf ${element.instanceOf}`);

    const tags = element.tags.filter((tag) => tag !== 'external');
    if (element.tags.includes('external')) body.push('external');
    if (tags.length > 0) body.push(`tag ${tags.join(', ')}`);

    for (const key of Object.keys(element.properties).sort()) {
      if (key === 'instances') {
        body.push(`instances ${quote(element.properties[key] ?? '')}`);
        continue;
      }
      if (key === 'icon') {
        body.push(`icon ${quote(element.properties[key] ?? '')}`);
        continue;
      }
      body.push(`prop ${key} ${quote(element.properties[key] ?? '')}`);
    }

    const children = model.children(element.id);
    if (body.length === 0 && children.length === 0) {
      push(depth, header);
      return;
    }

    push(depth, `${header} {`);
    for (const line of body) push(depth + 1, line);
    if (children.length > 0 && body.length > 0) push(depth + 1, '');
    for (const child of children) emitElement(child, depth + 1);
    push(depth, '}');
  };

  const roots = model.roots();
  for (const group of ['person', 'system', 'deploymentNode'] as const) {
    const members = roots.filter((element) => element.kind === group);
    if (members.length === 0) continue;
    for (const element of members) {
      emitElement(element, 1);
      push(0, '');
    }
  }
  // Anything with an unexpected root kind still gets emitted rather than lost.
  for (const element of roots) {
    if (element.kind === 'person' || element.kind === 'system' || element.kind === 'deploymentNode') {
      continue;
    }
    emitElement(element, 1);
    push(0, '');
  }

  if (workspace.relations.length > 0) {
    push(1, '// Relationships');
    for (const relation of [...workspace.relations].sort((a, b) => compareIds(a.id, b.id))) {
      emitRelation(relation, push, indentUnit, annotate);
    }
    push(0, '');
  }

  if (workspace.views.length > 0) {
    push(1, 'views {');
    for (const view of [...workspace.views].sort((a, b) => compareIds(a.id, b.id))) {
      emitView(view, push);
    }
    push(1, '}');
    push(0, '');
  }

  if (workspace.rules.length > 0) {
    push(1, 'rules {');
    const rules = [...workspace.rules].sort((a, b) => compareIds(a.id, b.id));
    rules.forEach((rule, index) => {
      emitRule(rule, push);
      if (index < rules.length - 1) push(0, '');
    });
    push(1, '}');
  }

  push(0, '}');

  // Collapse runs of blank lines so the output looks hand-written.
  const tidied: string[] = [];
  for (const line of lines) {
    if (line === '' && tidied[tidied.length - 1] === '') continue;
    tidied.push(line);
  }
  return `${tidied.join('\n').replace(/\n+$/, '')}\n`;
}

/** Emits a full source file from a plain workspace, without an ArchModel. */
export function emitWorkspaceData(
  workspace: Workspace,
  makeModel: (workspace: Workspace) => ArchModel,
  options: EmitOptions = {},
): string {
  return emitWorkspace(makeModel(workspace), options);
}

function emitRelation(
  relation: Relation,
  push: (depth: number, text: string) => void,
  indentUnit: string,
  annotate: boolean,
): void {
  void indentUnit;
  if (annotate && relation.provenance.source === 'inferred') {
    push(
      1,
      `// SOURCE: inferred by ${relation.provenance.detector} · CONFIDENCE: ${relation.provenance.confidence}`,
    );
  }

  const arrow = relation.direction === 'bi' ? '<->' : '->';
  const head = `${relation.sourceId} ${arrow} ${relation.destId}${
    relation.description ? ` ${quote(relation.description)}` : ''
  }`;

  const body: string[] = [];
  if (relation.technology) body.push(`technology ${quote(relation.technology)}`);
  if (relation.protocol) body.push(`protocol ${quote(relation.protocol)}`);
  if (relation.tags.length > 0) body.push(`tag ${relation.tags.join(', ')}`);
  for (const key of Object.keys(relation.properties).sort()) {
    body.push(`prop ${key} ${quote(relation.properties[key] ?? '')}`);
  }

  if (body.length === 0) {
    push(1, head);
    return;
  }
  push(1, `${head} {`);
  for (const line of body) push(2, line);
  push(1, '}');
}

function emitView(view: ViewDef, push: (depth: number, text: string) => void): void {
  const head = `${view.kind} ${view.id} ${quote(view.title)}${
    view.scopeId ? ` of ${view.scopeId}` : ''
  }`;

  if (view.kind === 'dynamic') {
    push(2, `${head} {`);
    for (const step of view.steps) {
      push(
        3,
        `${step.sourceId} -> ${step.destId}${step.description ? ` ${quote(step.description)}` : ''}`,
      );
    }
    push(2, '}');
    return;
  }

  if (view.include.length === 0 && view.exclude.length === 0) {
    push(2, head);
    return;
  }
  push(2, `${head} {`);
  for (const selector of view.include) push(3, `include ${selector}`);
  for (const selector of view.exclude) push(3, `exclude ${selector}`);
  push(2, '}');
}

function emitRule(rule: RuleDef, push: (depth: number, text: string) => void): void {
  push(2, `rule ${rule.id}${rule.title ? ` ${quote(rule.title)}` : ''} {`);
  push(3, `severity ${rule.severity}`);
  for (const assertion of rule.assertions) {
    switch (assertion.type) {
      case 'forbidDependency':
        push(3, `forbid ${assertion.from} -> ${assertion.to}`);
        break;
      case 'allowDependency':
        push(3, `allow ${assertion.from} -> ${assertion.to}`);
        break;
      case 'requireField':
        push(3, `require ${assertion.field} on ${assertion.on}`);
        break;
      case 'forbidCycles':
        push(3, `forbid cycles${assertion.within ? ` in ${assertion.within}` : ''}`);
        break;
      case 'forbidOrphans':
        push(3, `forbid orphans${assertion.within ? ` in ${assertion.within}` : ''}`);
        break;
    }
  }
  push(2, '}');
}

/** The owner an element would inherit, so redundant lines are not emitted. */
function inheritedOwner(model: ArchModel, element: Element): string | undefined {
  const parent = element.parentId ? model.element(element.parentId) : undefined;
  return parent?.owner;
}

function keywordFor(element: Element): string {
  if (element.subtype && SUGAR_KEYWORDS.has(element.subtype)) {
    // `database db "..."` reads better than `container db { kind database }`,
    // and the compiler infers the same structural kind from the nesting.
    if (element.kind === 'container' || element.kind === 'component') return element.subtype;
  }
  switch (element.kind) {
    case 'person':
      return 'person';
    case 'system':
      return 'system';
    case 'container':
      return 'container';
    case 'component':
      return 'component';
    case 'deploymentNode':
      return 'deploymentNode';
    case 'infrastructureNode':
      return 'infrastructureNode';
  }
}

/** Uses a block string when the text is multi-line, so nothing needs escaping. */
function emitDescription(text: string, indentUnit: string, depth: number): string {
  if (!text.includes('\n')) return `description ${quote(text)}`;
  const inner = text
    .split('\n')
    .map((line) => `${indentUnit.repeat(depth + 1)}${line}`)
    .join('\n');
  return `description """\n${inner}\n${indentUnit.repeat(depth)}"""`;
}

function quote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
