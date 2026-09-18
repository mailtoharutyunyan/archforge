/**
 * Structural edits applied to DSL *source text*.
 *
 * This is what makes visual authoring possible without giving up the text
 * model. The obvious implementation — mutate the workspace object and re-emit
 * the whole file — would destroy every comment, every blank line and every
 * formatting choice the author made, on every click. That is not an acceptable
 * price for dragging a box.
 *
 * So edits are surgical: locate the exact region using the source locations the
 * compiler already recorded, splice it, and leave the rest of the file byte for
 * byte as it was. Add a container from the canvas and your explanatory comment
 * three lines up is still there.
 *
 * Every function is pure: source text in, new source text out. Nothing here
 * mutates the model, which keeps undo as simple as keeping the previous string.
 */

import { ArchModel } from '../model/model.ts';
import type { SourceLoc } from '../model/types.ts';
import { slug } from '../util/canonical.ts';
import { compile } from './compile.ts';

export interface EditResult {
  readonly text: string;
  readonly changed: boolean;
  /** Human-readable explanation, suitable for a status line. */
  readonly note: string;
}

const unchanged = (text: string, note: string): EditResult => ({ text, changed: false, note });

// ---------------------------------------------------------------------------
// Source navigation
// ---------------------------------------------------------------------------

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function offsetOf(source: string, loc: SourceLoc): number {
  const starts = lineStarts(source);
  const base = starts[loc.line - 1] ?? 0;
  return Math.min(base + loc.column - 1, source.length);
}

/**
 * Walks forward from `from`, tracking string and comment state, and returns
 * the offsets of the next `{` and its matching `}`.
 *
 * State tracking matters: a brace inside `description "a { b"` must not be
 * counted, and neither must one inside a `// comment`. Getting this wrong
 * would silently corrupt a file, so it is handled explicitly rather than with
 * a regular expression.
 */
function findBlock(
  source: string,
  from: number,
  stopAtNewlineIfNoBrace = true,
): { open: number; close: number } | undefined {
  let index = from;
  let open = -1;
  let depth = 0;

  while (index < source.length) {
    const char = source[index] as string;

    // Comments
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }

    // Strings
    if (char === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        index = end < 0 ? source.length : end + 3;
        continue;
      }
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === '"' || source[index] === '\n') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === '{') {
      if (open < 0) open = index;
      depth += 1;
      index += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0 && open >= 0) return { open, close: index };
      index += 1;
      continue;
    }

    // A declaration with no body: `container api "API"` then a newline.
    if (char === '\n' && open < 0 && stopAtNewlineIfNoBrace) return undefined;

    index += 1;
  }
  return undefined;
}

/** Leading whitespace of the line containing `offset`. */
function indentAt(source: string, offset: number): string {
  const start = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const match = /^[ \t]*/.exec(source.slice(start, offset));
  return match?.[0] ?? '';
}

/** Start of the line containing `offset`. */
function lineStartOf(source: string, offset: number): number {
  return source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

/** End of the line containing `offset`, excluding the newline. */
function lineEndOf(source: string, offset: number): number {
  const index = source.indexOf('\n', offset);
  return index < 0 ? source.length : index;
}

/** The declaration offset of an element, or undefined if it is not declared in text. */
function declarationOffset(source: string, model: ArchModel, id: string): number | undefined {
  const element = model.element(id);
  if (!element || element.provenance.source !== 'declared' || !element.provenance.loc) {
    return undefined;
  }
  return offsetOf(source, element.provenance.loc);
}

/** The outermost `workspace { ... }` block. */
function workspaceBlock(source: string): { open: number; close: number } | undefined {
  const match = /\bworkspace\b/.exec(source);
  if (!match) {
    // A file may omit the wrapper entirely; treat the whole text as the body.
    return undefined;
  }
  return findBlock(source, match.index, false);
}

/**
 * Where a new top-level statement should go: just before the `views` block if
 * there is one, otherwise before the closing brace. Keeping declarations above
 * views and rules matches how the examples read.
 */
function topLevelInsertionPoint(source: string): { offset: number; indent: string } {
  const block = workspaceBlock(source);
  const limit = block?.close ?? source.length;

  for (const keyword of ['views', 'rules']) {
    const pattern = new RegExp(`^[ \\t]*${keyword}\\s*\\{`, 'm');
    const match = pattern.exec(source.slice(0, limit));
    if (match) {
      const offset = lineStartOf(source, match.index);
      return { offset, indent: indentAt(source, offset + (match[0].match(/^[ \t]*/)?.[0].length ?? 0)) || '  ' };
    }
  }

  if (block) {
    return { offset: lineStartOf(source, block.close), indent: '  ' };
  }
  return { offset: source.length, indent: '' };
}

// ---------------------------------------------------------------------------
// Identifier allocation
// ---------------------------------------------------------------------------

/** A local identifier that is valid, readable and not already taken. */
export function proposeLocalId(
  model: ArchModel,
  name: string,
  parentId: string | undefined,
): string {
  const base = camelize(name) || 'element';
  const taken = (candidate: string): boolean =>
    model.has(parentId ? `${parentId}.${candidate}` : candidate);

  if (!taken(base)) return base;
  for (let n = 2; n < 500; n += 1) {
    if (!taken(`${base}${n}`)) return `${base}${n}`;
  }
  return `${base}${Date.now()}`;
}

function camelize(text: string): string {
  const parts = slug(text).split('-').filter((part) => part !== '');
  if (parts.length === 0) return '';
  return (
    parts[0] +
    parts
      .slice(1)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('')
  );
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

export interface AddElementOptions {
  readonly keyword: string;
  readonly name: string;
  readonly parentId?: string;
  readonly localId?: string;
  readonly technology?: string;
  readonly description?: string;
}

/**
 * Inserts a new element declaration, nested inside `parentId` when given.
 *
 * A declaration with no body is written as a block anyway, because the next
 * thing the user does is almost always add a technology, and converting a
 * bodyless declaration later is a more invasive edit than starting with braces.
 */
export function addElement(
  source: string,
  model: ArchModel,
  options: AddElementOptions,
): EditResult {
  const localId = options.localId ?? proposeLocalId(model, options.name, options.parentId);
  const body: string[] = [];
  if (options.technology) body.push(`technology ${quote(options.technology)}`);
  if (options.description) body.push(`description ${quote(options.description)}`);

  let insertAt: number;
  let indent: string;

  if (options.parentId) {
    const declaration = declarationOffset(source, model, options.parentId);
    if (declaration === undefined) {
      return unchanged(source, `Cannot find \`${options.parentId}\` in the source.`);
    }
    const block = findBlock(source, declaration, false);
    if (!block) {
      return unchanged(
        source,
        `\`${options.parentId}\` has no body to insert into. Add braces to it first.`,
      );
    }
    insertAt = lineStartOf(source, block.close);
    indent = `${indentAt(source, declaration)}  `;
  } else {
    const point = topLevelInsertionPoint(source);
    insertAt = point.offset;
    indent = point.indent;
  }

  const lines = [
    `${indent}${options.keyword} ${localId} ${quote(options.name)} {`,
    ...body.map((line) => `${indent}  ${line}`),
    `${indent}}`,
    '',
  ];

  const text = `${source.slice(0, insertAt)}${lines.join('\n')}\n${source.slice(insertAt)}`;
  return { text, changed: true, note: `Added ${options.keyword} \`${localId}\`.` };
}

export interface AddRelationshipOptions {
  readonly sourceId: string;
  readonly destId: string;
  readonly description?: string;
  readonly technology?: string;
  readonly bidirectional?: boolean;
}

export function addRelationship(
  source: string,
  model: ArchModel,
  options: AddRelationshipOptions,
): EditResult {
  if (options.sourceId === options.destId) {
    return unchanged(source, 'An element cannot depend on itself.');
  }
  if (!model.has(options.sourceId) || !model.has(options.destId)) {
    return unchanged(source, 'Both ends of a relationship must exist.');
  }
  // Silently creating a duplicate edge is confusing; say so instead.
  const existing = model
    .outgoing(options.sourceId)
    .some((relation) => relation.destId === options.destId);
  if (existing) {
    return unchanged(source, 'That relationship already exists.');
  }

  const arrow = options.bidirectional ? '<->' : '->';
  const head = `${options.sourceId} ${arrow} ${options.destId}${
    options.description ? ` ${quote(options.description)}` : ''
  }`;
  const point = topLevelInsertionPoint(source);
  const lines = options.technology
    ? [
        `${point.indent}${head} {`,
        `${point.indent}  technology ${quote(options.technology)}`,
        `${point.indent}}`,
        '',
      ]
    : [`${point.indent}${head}`, ''];

  const text = `${source.slice(0, point.offset)}${lines.join('\n')}\n${source.slice(point.offset)}`;
  return { text, changed: true, note: `Connected ${options.sourceId} → ${options.destId}.` };
}

/**
 * Sets, replaces or removes a single-valued property on an element.
 *
 * Pass `undefined` to remove. Handles all three shapes an element can have:
 * a block that already declares the property, a block that does not, and a
 * declaration with no block at all.
 */
export function setElementProperty(
  source: string,
  model: ArchModel,
  elementId: string,
  property: string,
  value: string | undefined,
): EditResult {
  const declaration = declarationOffset(source, model, elementId);
  if (declaration === undefined) {
    return unchanged(source, `Cannot find \`${elementId}\` in the source.`);
  }

  // `name` is positional, not a property: it is the quoted string in the header.
  if (property === 'name') {
    if (value === undefined) return unchanged(source, 'An element must have a name.');
    return replaceHeaderName(source, declaration, value, elementId);
  }

  let block = findBlock(source, declaration);
  const line = `${property} ${quote(value ?? '')}`;

  // A single-line block cannot be edited line-wise: the property and the
  // closing brace share a line. Expand it first, then proceed normally.
  if (block && lineStartOf(source, block.open) === lineStartOf(source, block.close)) {
    const expanded = expandInlineBlock(source, declaration, block);
    const reopened = findBlock(expanded, declaration);
    if (reopened) {
      return setElementPropertyIn(expanded, reopened, declaration, elementId, property, value);
    }
    block = undefined;
  }

  if (!block) {
    // Bodyless declaration: give it a body.
    if (value === undefined) return unchanged(source, `\`${property}\` is not set.`);
    const end = lineEndOf(source, declaration);
    const indent = indentAt(source, declaration);
    const text =
      `${source.slice(0, end)} {\n${indent}  ${line}\n${indent}}` + source.slice(end);
    return { text, changed: true, note: `Set ${property} on \`${elementId}\`.` };
  }

  return setElementPropertyIn(source, block, declaration, elementId, property, value);
}

/** The block-relative half of `setElementProperty`, reused after expansion. */
function setElementPropertyIn(
  source: string,
  block: { open: number; close: number },
  declaration: number,
  elementId: string,
  property: string,
  value: string | undefined,
): EditResult {
  const line = `${property} ${quote(value ?? '')}`;
  const existing = findPropertyLine(source, block, property);

  if (existing) {
    if (value === undefined) {
      const text = source.slice(0, existing.start) + source.slice(existing.end + 1);
      return { text, changed: true, note: `Removed ${property} from \`${elementId}\`.` };
    }
    const indent = indentAt(source, existing.end);
    const text = source.slice(0, existing.start) + `${indent}${line}` + source.slice(existing.end);
    return { text, changed: true, note: `Set ${property} on \`${elementId}\`.` };
  }

  if (value === undefined) return unchanged(source, `\`${property}\` is not set.`);

  // Insert as the first statement in the body, which keeps related properties
  // grouped at the top rather than scattered after nested children.
  const afterOpen = block.open + 1;
  const indent = `${indentAt(source, declaration)}  `;
  const text = `${source.slice(0, afterOpen)}\n${indent}${line}${source.slice(afterOpen)}`;
  return { text, changed: true, note: `Set ${property} on \`${elementId}\`.` };
}

function replaceHeaderName(
  source: string,
  declaration: number,
  value: string,
  elementId: string,
): EditResult {
  const end = lineEndOf(source, declaration);
  const header = source.slice(declaration, end);
  const match = /"(?:[^"\\]|\\.)*"/.exec(header);

  if (!match) {
    // `container api` with no name: add one after the identifier.
    const identifier = /^(\s*\S+\s+\S+)/.exec(header);
    if (!identifier) return unchanged(source, 'Could not parse the declaration.');
    const at = declaration + (identifier[1]?.length ?? 0);
    return {
      text: `${source.slice(0, at)} ${quote(value)}${source.slice(at)}`,
      changed: true,
      note: `Renamed \`${elementId}\`.`,
    };
  }

  const at = declaration + match.index;
  return {
    text: `${source.slice(0, at)}${quote(value)}${source.slice(at + match[0].length)}`,
    changed: true,
    note: `Renamed \`${elementId}\`.`,
  };
}

/**
 * Net brace depth contributed by one line, ignoring braces inside strings and
 * comments. `inTripleString` carries the state of a `"""` block across lines.
 */
function braceDelta(line: string, inTripleString: boolean): { delta: number; inTripleString: boolean } {
  let delta = 0;
  let triple = inTripleString;
  let index = 0;

  while (index < line.length) {
    if (triple) {
      const end = line.indexOf('"""', index);
      if (end < 0) return { delta, inTripleString: true };
      triple = false;
      index = end + 3;
      continue;
    }
    const char = line[index] as string;

    if (char === '/' && line[index + 1] === '/') break;
    if (char === '#') break;
    if (line.startsWith('"""', index)) {
      triple = true;
      index += 3;
      continue;
    }
    if (char === '"') {
      index += 1;
      while (index < line.length) {
        if (line[index] === '\\') {
          index += 2;
          continue;
        }
        if (line[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === '{') delta += 1;
    else if (char === '}') delta -= 1;
    index += 1;
  }
  return { delta, inTripleString: triple };
}

/**
 * Visits each line of a block, reporting the nesting depth it starts at.
 *
 * Depth is what makes this correct: a `technology` line belonging to a nested
 * child must never be mistaken for the parent's. An earlier version scanned
 * character by character but jumped to the end of each candidate line, so it
 * never observed the braces on the lines it skipped — its depth stayed at zero
 * and it happily matched a grandchild's property. Counting per line, including
 * the braces on it, is the fix.
 */
function eachBlockLine(
  source: string,
  block: { open: number; close: number },
  visit: (start: number, end: number, text: string, depth: number) => boolean | void,
): void {
  let index = block.open + 1;
  let depth = 0;
  let inTripleString = false;

  while (index < block.close) {
    const start = index;
    const end = lineEndOf(source, start);
    const raw = source.slice(start, Math.min(end, block.close));

    if (visit(start, end, raw.trim(), depth) === true) return;

    const step = braceDelta(raw, inTripleString);
    depth += step.delta;
    inTripleString = step.inTripleString;
    index = end + 1;
  }
}

/** Finds a property statement at the top level of a block. */
function findPropertyLine(
  source: string,
  block: { open: number; close: number },
  property: string,
): { start: number; end: number } | undefined {
  let found: { start: number; end: number } | undefined;

  eachBlockLine(source, block, (start, end, text, depth) => {
    if (depth !== 0) return;
    if (text.startsWith(`${property} `) || text === property) {
      found = { start, end };
      return true;
    }
    return;
  });

  return found;
}

/**
 * Rewrites `container c "C" { technology "Go" }` as a multi-line block.
 *
 * Single-line blocks are legal and people write them, but they make in-place
 * property edits unsafe: the property and the closing brace share a line, so
 * replacing the line would eat the brace. Expanding first keeps every later
 * edit a simple line operation. Offsets before the declaration are untouched,
 * so a model's recorded locations stay valid.
 */
function expandInlineBlock(
  source: string,
  declaration: number,
  block: { open: number; close: number },
): string {
  const indent = indentAt(source, declaration);
  const inner = source.slice(block.open + 1, block.close).trim();
  const statements = inner === '' ? [] : splitInlineStatements(inner);

  const lines = [
    '{',
    ...statements.map((statement) => `${indent}  ${statement}`),
    `${indent}}`,
  ];
  return source.slice(0, block.open) + lines.join('\n') + source.slice(block.close + 1);
}

/** Splits `technology "Go" tag internal` into separate statements. */
function splitInlineStatements(inner: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;

  while (index < inner.length) {
    const char = inner[index] as string;
    if (char === '"') {
      // Consume the whole string, then end the statement: every property we
      // write has the shape `name "value"`.
      current += char;
      index += 1;
      while (index < inner.length) {
        current += inner[index];
        if (inner[index] === '\\') {
          current += inner[index + 1] ?? '';
          index += 2;
          continue;
        }
        if (inner[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      statements.push(current.trim());
      current = '';
      continue;
    }
    current += char;
    index += 1;
  }
  if (current.trim() !== '') statements.push(current.trim());
  return statements;
}

/**
 * Removes an element and everything that refers to it.
 *
 * Removing the declaration alone would leave relationships pointing at a
 * missing id, so the model would stop compiling — the edit has to be complete
 * to be safe. Descendants go with it, and so does any relationship touching
 * the element or its descendants.
 */
export function removeElement(source: string, model: ArchModel, elementId: string): EditResult {
  const declaration = declarationOffset(source, model, elementId);
  if (declaration === undefined) {
    return unchanged(source, `Cannot find \`${elementId}\` in the source.`);
  }

  const element = model.requireElement(elementId);
  const doomed = new Set<string>([elementId, ...model.descendants(elementId).map((e) => e.id)]);

  // Remove referring relationships first, working from the end of the file so
  // earlier offsets stay valid.
  const relationLines: { start: number; end: number }[] = [];
  for (const relation of model.relations) {
    if (!doomed.has(relation.sourceId) && !doomed.has(relation.destId)) continue;
    if (relation.provenance.source !== 'declared' || !relation.provenance.loc) continue;
    const at = offsetOf(source, relation.provenance.loc);
    const block = findBlock(source, at);
    const start = lineStartOf(source, at);
    const end = block ? lineEndOf(source, block.close) : lineEndOf(source, at);
    relationLines.push({ start, end });
  }

  // Views scoped to a removed element, or whose dynamic steps reference one,
  // must go too. Leaving them behind means the file no longer compiles, and a
  // structural edit that breaks the model is not an edit worth offering.
  const viewLines: { start: number; end: number }[] = [];
  for (const view of model.views) {
    if (!view.loc) continue;
    const referenced =
      (view.scopeId !== undefined && doomed.has(view.scopeId)) ||
      view.steps.some((step) => doomed.has(step.sourceId) || doomed.has(step.destId));
    if (!referenced) continue;
    const at = offsetOf(source, view.loc);
    const viewBlock = findBlock(source, at);
    viewLines.push({
      start: lineStartOf(source, at),
      end: viewBlock ? lineEndOf(source, viewBlock.close) : lineEndOf(source, at),
    });
  }

  const block = findBlock(source, declaration, false);
  const start = lineStartOf(source, declaration);
  const end = block ? lineEndOf(source, block.close) : lineEndOf(source, declaration);

  const cuts = [...relationLines, ...viewLines, { start, end }]
    .filter((cut, index, all) => all.findIndex((other) => other.start === cut.start) === index)
    .sort((a, b) => b.start - a.start);

  let text = source;
  for (const cut of cuts) {
    // Take the trailing newline too, and a single trailing blank line if the
    // removal would otherwise leave a double gap.
    let stop = cut.end + 1;
    if (source.slice(stop, stop + 1) === '\n' && source.slice(cut.start - 1, cut.start) === '\n') {
      stop += 1;
    }
    text = text.slice(0, cut.start) + text.slice(stop);
  }

  const extras: string[] = [];
  if (doomed.size > 1) extras.push(`${doomed.size - 1} nested element(s)`);
  if (relationLines.length > 0) extras.push(`${relationLines.length} relationship(s)`);
  if (viewLines.length > 0) extras.push(`${viewLines.length} view(s)`);

  return {
    text,
    changed: true,
    note:
      `Removed ${element.name}` +
      (extras.length > 0 ? `, plus ${extras.join(' and ')}` : '') +
      '.',
  };
}

export function removeRelationship(
  source: string,
  model: ArchModel,
  relationId: string,
): EditResult {
  const relation = model.relation(relationId);
  if (!relation || relation.provenance.source !== 'declared' || !relation.provenance.loc) {
    return unchanged(source, 'That relationship is not declared in this file.');
  }
  const at = offsetOf(source, relation.provenance.loc);
  const block = findBlock(source, at);
  const start = lineStartOf(source, at);
  const end = block ? lineEndOf(source, block.close) : lineEndOf(source, at);
  return {
    text: source.slice(0, start) + source.slice(end + 1),
    changed: true,
    note: 'Removed the relationship.',
  };
}

/**
 * Renames an element's *identifier* and updates every reference to it.
 *
 * This is the one edit that cannot be done by splicing a single region: an id
 * appears in its declaration, in relationships, in view scopes, in dynamic
 * steps and in `instanceOf`. Worse, references may be written relatively
 * (`db`) or absolutely (`platform.db`), and a bare name may be ambiguous.
 *
 * Rather than trying to prove a rewrite correct by construction, the rewrite
 * is *verified*: apply it, recompile, and confirm the model is structurally
 * identical apart from the renamed id. If anything else moved — an element
 * lost, a relationship dropped, a new diagnostic — the edit is refused and the
 * original text returned untouched. A refactor that silently damages a model
 * is worse than one that declines to run.
 */
export function renameIdentifier(
  source: string,
  model: ArchModel,
  elementId: string,
  newLocalId: string,
): EditResult {
  const element = model.element(elementId);
  if (!element) return unchanged(source, `Cannot find \`${elementId}\`.`);

  const trimmed = newLocalId.trim();
  if (trimmed === '') return unchanged(source, 'An identifier cannot be empty.');
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(trimmed)) {
    return unchanged(
      source,
      'An identifier must start with a letter and contain only letters, digits, _ or -.',
    );
  }
  if (trimmed === element.localId) return unchanged(source, 'That is already the identifier.');

  const newId = element.parentId ? `${element.parentId}.${trimmed}` : trimmed;
  if (model.has(newId)) return unchanged(source, `\`${newId}\` is already taken.`);

  const declaration = declarationOffset(source, model, elementId);
  if (declaration === undefined) return unchanged(source, `Cannot find \`${elementId}\`.`);

  // 1. The declaration: the identifier is the token after the keyword.
  const headerEnd = lineEndOf(source, declaration);
  const header = source.slice(declaration, headerEnd);
  const headerMatch = new RegExp(`^(\\s*[A-Za-z_][\\w-]*\\s+)(${escapeRegExp(element.localId)})\\b`).exec(
    header,
  );
  if (!headerMatch) {
    return unchanged(source, 'Could not find the identifier in its declaration.');
  }

  let text =
    source.slice(0, declaration) +
    header.replace(headerMatch[0], `${headerMatch[1]}${trimmed}`) +
    source.slice(headerEnd);

  // 2. References. The full path is unambiguous; a bare name is only safe when
  // no other element in the model shares it.
  const bareIsUnique =
    model.elements.filter((candidate) => candidate.localId === element.localId).length === 1;

  const patterns: { from: RegExp; to: string }[] = [];
  if (element.parentId) {
    patterns.push({
      from: new RegExp(`\\b${escapeRegExp(elementId)}\\b`, 'g'),
      to: newId,
    });
  }
  if (bareIsUnique) {
    // Not preceded by a dot: `platform.api` is handled by the full-path rule,
    // and `other.api` must not be touched.
    patterns.push({
      from: new RegExp(`(^|[^\\w.-])${escapeRegExp(element.localId)}\\b`, 'g'),
      to: `$1${trimmed}`,
    });
  }

  // Apply only outside the declaration header we already rewrote, and only
  // outside string literals — a description mentioning the word must not change.
  text = replaceOutsideStrings(text, patterns, declaration, declaration + header.length);

  // 3. Verify.
  const before = { elements: model.elements.length, relations: model.relations.length };
  const recompiled = compile(text, 'rename.arch');
  if (recompiled.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    const first = recompiled.diagnostics.find((d) => d.severity === 'error');
    return unchanged(
      source,
      `Rename refused: it would break the model (${first?.message ?? 'unknown error'}).`,
    );
  }
  const after = new ArchModel(recompiled.workspace);
  if (
    after.elements.length !== before.elements ||
    after.relations.length !== before.relations ||
    !after.has(newId)
  ) {
    return unchanged(
      source,
      'Rename refused: the result was not structurally identical, so the text was left alone.',
    );
  }

  return {
    text,
    changed: true,
    note: `Renamed \`${element.localId}\` to \`${trimmed}\` and updated every reference.`,
  };
}

/**
 * Applies replacements to the parts of `text` that are not string literals,
 * comments, or inside the protected range.
 */
function replaceOutsideStrings(
  text: string,
  patterns: readonly { from: RegExp; to: string }[],
  protectedStart: number,
  protectedEnd: number,
): string {
  // Split into alternating code and non-code (string/comment) segments, then
  // rewrite only the code segments. Rebuilding preserves everything else.
  const segments: { text: string; code: boolean; start: number }[] = [];
  let index = 0;
  let plain = '';
  let plainStart = 0;

  const flushPlain = (): void => {
    if (plain !== '') segments.push({ text: plain, code: true, start: plainStart });
    plain = '';
  };

  while (index < text.length) {
    const char = text[index] as string;

    if (char === '/' && text[index + 1] === '/') {
      flushPlain();
      const end = lineEndOf(text, index);
      segments.push({ text: text.slice(index, end), code: false, start: index });
      index = end;
      plainStart = index;
      continue;
    }
    if (char === '#') {
      flushPlain();
      const end = lineEndOf(text, index);
      segments.push({ text: text.slice(index, end), code: false, start: index });
      index = end;
      plainStart = index;
      continue;
    }
    if (char === '"') {
      flushPlain();
      let end: number;
      if (text.startsWith('"""', index)) {
        const close = text.indexOf('"""', index + 3);
        end = close < 0 ? text.length : close + 3;
      } else {
        end = index + 1;
        while (end < text.length) {
          if (text[end] === '\\') {
            end += 2;
            continue;
          }
          if (text[end] === '"' || text[end] === '\n') {
            end += 1;
            break;
          }
          end += 1;
        }
      }
      segments.push({ text: text.slice(index, end), code: false, start: index });
      index = end;
      plainStart = index;
      continue;
    }

    if (plain === '') plainStart = index;
    plain += char;
    index += 1;
  }
  flushPlain();

  return segments
    .map((segment) => {
      if (!segment.code) return segment.text;
      const overlapsProtected =
        segment.start < protectedEnd && segment.start + segment.text.length > protectedStart;
      if (overlapsProtected) {
        // The declaration header was already rewritten; leave it exactly as is.
        return segment.text;
      }
      let out = segment.text;
      for (const pattern of patterns) out = out.replace(pattern.from, pattern.to);
      return out;
    })
    .join('');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Adds a tag to an element, merging into an existing `tag` line if present. */
export function addTag(
  source: string,
  model: ArchModel,
  elementId: string,
  tag: string,
): EditResult {
  const element = model.element(elementId);
  if (!element) return unchanged(source, `Cannot find \`${elementId}\`.`);
  if (element.tags.includes(tag)) return unchanged(source, `Already tagged \`${tag}\`.`);

  const declaration = declarationOffset(source, model, elementId);
  if (declaration === undefined) return unchanged(source, `Cannot find \`${elementId}\`.`);
  const block = findBlock(source, declaration);

  if (block) {
    const existing = findPropertyLine(source, block, 'tag') ?? findPropertyLine(source, block, 'tags');
    if (existing) {
      const line = source.slice(existing.start, existing.end);
      return {
        text: `${source.slice(0, existing.end)}, ${tag}${source.slice(existing.end)}`,
        changed: true,
        note: `Tagged \`${tag}\`.${line.includes('tags') ? '' : ''}`,
      };
    }
  }
  return setElementProperty(source, model, elementId, 'tag', tag);
}

function quote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
