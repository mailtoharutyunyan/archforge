/**
 * Compiles the AST into a `Workspace`.
 *
 * Everything that makes the model trustworthy happens here: identifiers get
 * qualified into stable ids, references get resolved against enclosing scopes,
 * nesting gets checked against the C4 structure, and anything unresolvable
 * becomes a diagnostic rather than a silently dropped edge.
 */

import { diag, type Diagnostic } from '../diagnostics.ts';
import type {
  Assertion,
  DynamicStep,
  Element,
  ElementKind,
  RequirableField,
  Relation,
  RuleDef,
  Severity,
  SourceLoc,
  ViewDef,
  ViewKind,
  Workspace,
} from '../model/types.ts';
import { normalizeTags, slug, sortBy } from '../util/canonical.ts';
import type {
  AstElementDecl,
  AstPropertyArg,
  AstPropertyStmt,
  AstRef,
  AstRelationDecl,
  AstRuleDecl,
  AstStatement,
  AstViewDecl,
} from './ast.ts';
import { parse } from './parser.ts';

/**
 * Keyword to structural kind. Sugar keywords (`database`, `queue`, ...) have no
 * fixed kind: they take the kind implied by where they are nested, which is
 * what keeps the structural taxonomy small while still letting authors write
 * what they mean.
 */
const STRICT_KINDS: Readonly<Record<string, ElementKind>> = {
  person: 'person',
  actor: 'person',
  system: 'system',
  softwareSystem: 'system',
  container: 'container',
  component: 'component',
  deploymentNode: 'deploymentNode',
  node: 'deploymentNode',
  infrastructureNode: 'infrastructureNode',
  infra: 'infrastructureNode',
};

/** Sugar keyword to subtype. Kind is derived from nesting depth. */
const SUGAR_SUBTYPES: Readonly<Record<string, string>> = {
  database: 'database',
  queue: 'queue',
  topic: 'topic',
  api: 'api',
  service: 'service',
  browser: 'browser',
  mobileApp: 'mobileApp',
  function: 'function',
  cache: 'cache',
};

const KNOWN_ELEMENT_PROPERTIES = new Set([
  'description',
  'technology',
  'tech',
  'owner',
  'team',
  'url',
  'kind',
  'subtype',
  'icon',
  'source',
  'instanceOf',
  'instances',
  'tag',
  'tags',
  'external',
  'prop',
  'property',
]);

const KNOWN_RELATION_PROPERTIES = new Set([
  'description',
  'technology',
  'tech',
  'protocol',
  'tag',
  'tags',
  'prop',
  'property',
]);

const REQUIRABLE_FIELDS = new Set<string>(['description', 'technology', 'owner', 'source']);

export interface CompileResult {
  readonly workspace: Workspace;
  readonly diagnostics: readonly Diagnostic[];
}

export interface SourceFile {
  readonly file: string;
  readonly text: string;
}

/** Parses and compiles a single DSL source. */
export function compile(source: string, file = 'architecture.arch'): CompileResult {
  return compileFiles([{ file, text: source }]);
}

/**
 * Parses and compiles several DSL sources into one workspace. Multi-file input
 * is how a large organisation splits architecture across teams and repos
 * without a central database.
 */
export function compileFiles(sources: readonly SourceFile[]): CompileResult {
  const diagnostics: Diagnostic[] = [];
  const statements: AstStatement[] = [];
  let workspaceName: string | undefined;

  for (const source of sources) {
    const parsed = parse(source.text, source.file);
    diagnostics.push(...parsed.diagnostics);
    statements.push(...parsed.statements);
    if (parsed.workspaceName && !workspaceName) workspaceName = parsed.workspaceName;
  }

  const compiler = new Compiler(diagnostics);
  const workspace = compiler.run(statements, workspaceName);
  return { workspace, diagnostics };
}

interface PendingRelation {
  readonly decl: AstRelationDecl;
  readonly scope: readonly string[];
}

class Compiler {
  readonly #diagnostics: Diagnostic[];
  readonly #elements = new Map<string, Element>();
  readonly #declaredAt = new Map<string, SourceLoc | undefined>();
  readonly #pendingRelations: PendingRelation[] = [];
  readonly #views: ViewDef[] = [];
  readonly #rules: RuleDef[] = [];
  readonly #workspaceProperties: Record<string, string> = {};
  #workspaceDescription: string | undefined;

  constructor(diagnostics: Diagnostic[]) {
    this.#diagnostics = diagnostics;
  }

  run(statements: readonly AstStatement[], workspaceName: string | undefined): Workspace {
    // Pass 1: declare every element, so references can point forwards.
    this.#collectElements(statements, undefined);
    // Pass 2: resolve relationships, views and rules against the full model.
    const relations = this.#resolveRelations();
    this.#resolveInstanceRefs();

    return {
      name: workspaceName ?? 'Unnamed workspace',
      description: this.#workspaceDescription,
      elements: sortBy([...this.#elements.values()], (e) => e.id),
      relations,
      views: sortBy(this.#views, (v) => v.id),
      rules: sortBy(this.#rules, (r) => r.id),
      properties: { ...this.#workspaceProperties },
    };
  }

  // ------------------------------------------------------------ declarations

  #collectElements(statements: readonly AstStatement[], parentId: string | undefined): void {
    for (const statement of statements) {
      switch (statement.kind) {
        case 'element':
          this.#declareElement(statement, parentId);
          break;
        case 'relation':
          this.#pendingRelations.push({
            decl: statement,
            scope: parentId ? this.#scopeChain(parentId) : [],
          });
          break;
        case 'property':
          if (parentId === undefined) this.#applyWorkspaceProperty(statement);
          break;
        case 'views':
          for (const view of statement.views) this.#declareView(view);
          break;
        case 'rules':
          for (const rule of statement.rules) this.#declareRule(rule);
          break;
      }
    }
  }

  #declareElement(decl: AstElementDecl, parentId: string | undefined): void {
    const parent = parentId ? this.#elements.get(parentId) : undefined;
    const kind = this.#kindFor(decl, parent);
    if (!kind) return;

    if (!this.#checkNesting(decl, kind, parent)) return;

    const id = parentId ? `${parentId}.${decl.id}` : decl.id;
    if (this.#elements.has(id)) {
      const previous = this.#declaredAt.get(id);
      this.#error(
        decl.loc,
        'compile/duplicate-id',
        `\`${id}\` is already declared${previous ? ` at ${previous.file}:${previous.line}` : ''}.`,
        'Identifiers must be unique within their parent.',
      );
      return;
    }

    const attributes = this.#readElementProperties(decl, kind);
    const element: Element = {
      id,
      localId: decl.id,
      kind,
      subtype: attributes.subtype ?? SUGAR_SUBTYPES[decl.keyword],
      name: decl.name ?? decl.id,
      description: attributes.description,
      technology: attributes.technology,
      owner: attributes.owner ?? parent?.owner,
      url: attributes.url,
      tags: normalizeTags(attributes.tags),
      properties: attributes.properties,
      parentId,
      sourcePath: attributes.sourcePath,
      instanceOf: attributes.instanceOf,
      provenance: { source: 'declared', loc: decl.loc },
    };

    this.#elements.set(id, element);
    this.#declaredAt.set(id, decl.loc);
    this.#collectElements(decl.body, id);
  }

  #kindFor(decl: AstElementDecl, parent: Element | undefined): ElementKind | undefined {
    const strict = STRICT_KINDS[decl.keyword];
    if (strict) return strict;
    if (SUGAR_SUBTYPES[decl.keyword]) {
      // `database`, `queue`, ... mean different structural things depending on
      // where they appear, mirroring how C4 actually works.
      if (!parent) return 'system';
      if (parent.kind === 'system') return 'container';
      if (parent.kind === 'container') return 'component';
      if (parent.kind === 'deploymentNode') return 'infrastructureNode';
      this.#error(
        decl.loc,
        'compile/invalid-nesting',
        `\`${decl.keyword}\` cannot be declared inside a ${parent.kind}.`,
      );
      return undefined;
    }
    this.#error(decl.loc, 'compile/unknown-keyword', `Unknown declaration \`${decl.keyword}\`.`);
    return undefined;
  }

  /** Enforces the C4 containment rules that make view derivation unambiguous. */
  #checkNesting(decl: AstElementDecl, kind: ElementKind, parent: Element | undefined): boolean {
    const fail = (message: string, hint?: string): boolean => {
      this.#error(decl.loc, 'compile/invalid-nesting', message, hint);
      return false;
    };
    switch (kind) {
      case 'person':
        return parent ? fail('A person must be declared at the top level.') : true;
      case 'system':
        return parent && parent.kind !== 'system'
          ? fail('A system must be declared at the top level.')
          : true;
      case 'container':
        return parent?.kind === 'system'
          ? true
          : fail(
              'A container must be declared inside a system.',
              'Wrap it in `system <id> "<name>" { ... }`.',
            );
      case 'component':
        return parent?.kind === 'container'
          ? true
          : fail('A component must be declared inside a container.');
      case 'deploymentNode':
        return !parent || parent.kind === 'deploymentNode'
          ? true
          : fail('A deployment node must be top level or nested in another deployment node.');
      case 'infrastructureNode':
        return parent?.kind === 'deploymentNode'
          ? true
          : fail('An infrastructure node must be declared inside a deployment node.');
    }
  }

  // --------------------------------------------------------------- properties

  #readElementProperties(
    decl: AstElementDecl,
    kind: ElementKind,
  ): {
    description?: string;
    technology?: string;
    owner?: string;
    url?: string;
    subtype?: string;
    sourcePath?: string;
    instanceOf?: string;
    tags: string[];
    properties: Record<string, string>;
  } {
    const tags: string[] = [];
    const properties: Record<string, string> = {};
    let description: string | undefined;
    let technology: string | undefined;
    let owner: string | undefined;
    let url: string | undefined;
    let subtype: string | undefined;
    let sourcePath: string | undefined;
    let instanceOf: string | undefined;

    for (const statement of decl.body) {
      if (statement.kind !== 'property') continue;
      const name = statement.name;
      if (!KNOWN_ELEMENT_PROPERTIES.has(name)) {
        this.#unknownProperty(statement, KNOWN_ELEMENT_PROPERTIES);
        continue;
      }
      switch (name) {
        case 'description':
          description = this.#text(statement, 0);
          break;
        case 'technology':
        case 'tech':
          technology = this.#text(statement, 0);
          break;
        case 'owner':
        case 'team':
          owner = this.#text(statement, 0);
          break;
        case 'url':
          url = this.#text(statement, 0);
          break;
        case 'kind':
        case 'subtype':
          subtype = this.#text(statement, 0);
          break;
        case 'icon':
          properties['icon'] = this.#text(statement, 0) ?? '';
          break;
        case 'source':
          sourcePath = normalizeRepoPath(this.#text(statement, 0) ?? '');
          break;
        case 'instanceOf':
          instanceOf = this.#refText(statement, 0);
          if (kind !== 'deploymentNode' && kind !== 'infrastructureNode') {
            this.#error(
              statement.loc,
              'compile/misplaced-property',
              '`instanceOf` is only meaningful on deployment or infrastructure nodes.',
            );
          }
          break;
        case 'instances':
          properties['instances'] = this.#text(statement, 0) ?? '';
          break;
        case 'external':
          tags.push('external');
          break;
        case 'tag':
        case 'tags':
          for (const arg of statement.args) tags.push(argText(arg));
          break;
        case 'prop':
        case 'property': {
          const key = this.#text(statement, 0);
          const value = this.#text(statement, 1);
          if (key) properties[key] = value ?? '';
          break;
        }
      }
    }

    return {
      description,
      technology,
      owner,
      url,
      subtype,
      sourcePath,
      instanceOf,
      tags,
      properties,
    };
  }

  #applyWorkspaceProperty(statement: AstPropertyStmt): void {
    if (statement.name === 'description') {
      this.#workspaceDescription = this.#text(statement, 0);
      return;
    }
    if (statement.name === 'prop' || statement.name === 'property') {
      const key = this.#text(statement, 0);
      const value = this.#text(statement, 1);
      if (key) this.#workspaceProperties[key] = value ?? '';
      return;
    }
    this.#error(
      statement.loc,
      'compile/unknown-property',
      `\`${statement.name}\` is not valid at the top level.`,
      'Top level accepts `description` and `prop <key> "<value>"`.',
    );
  }

  // -------------------------------------------------------------- references

  #scopeChain(id: string): string[] {
    // Innermost scope first: `a.b.c` yields ["a.b.c", "a.b", "a"].
    const parts = id.split('.');
    const chain: string[] = [];
    for (let i = parts.length; i > 0; i -= 1) chain.push(parts.slice(0, i).join('.'));
    return chain;
  }

  /**
   * Resolves a dotted reference. Tried in order: relative to each enclosing
   * scope (innermost first), absolute, then a unique suffix match. The suffix
   * fallback is what lets `postgres` mean `payments.postgres` when there is
   * exactly one candidate, while a genuine ambiguity is reported with the list
   * of options instead of being resolved arbitrarily.
   */
  #resolveRef(ref: AstRef, scope: readonly string[]): string | undefined {
    const path = ref.path.join('.');
    for (const prefix of scope) {
      const candidate = `${prefix}.${path}`;
      if (this.#elements.has(candidate)) return candidate;
    }
    if (this.#elements.has(path)) return path;

    const suffix = `.${path}`;
    const matches = [...this.#elements.keys()].filter((id) => id.endsWith(suffix)).sort();
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      this.#error(
        ref.loc,
        'compile/ambiguous-reference',
        `\`${path}\` is ambiguous.`,
        `Candidates: ${matches.join(', ')}. Use the full path.`,
      );
      return undefined;
    }

    this.#error(
      ref.loc,
      'compile/unresolved-reference',
      `Cannot resolve \`${path}\`.`,
      this.#suggestIds(path),
    );
    return undefined;
  }

  #suggestIds(path: string): string | undefined {
    const target = path.split('.').pop() ?? path;
    const candidates = [...this.#elements.keys()]
      .map((id) => ({ id, score: editDistance(target, id.split('.').pop() ?? id) }))
      .filter((c) => c.score <= 2)
      .sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : 1))
      .slice(0, 3)
      .map((c) => c.id);
    return candidates.length > 0 ? `Did you mean: ${candidates.join(', ')}?` : undefined;
  }

  // -------------------------------------------------------------- relations

  #resolveRelations(): Relation[] {
    interface Draft {
      sourceId: string;
      destId: string;
      description?: string;
      technology?: string;
      protocol?: string;
      bidirectional: boolean;
      tags: string[];
      properties: Record<string, string>;
      loc: SourceLoc;
    }

    const drafts: Draft[] = [];

    for (const pending of this.#pendingRelations) {
      const sourceId = this.#resolveRef(pending.decl.source, pending.scope);
      const destId = this.#resolveRef(pending.decl.dest, pending.scope);
      if (!sourceId || !destId) continue;
      if (sourceId === destId) {
        this.#error(
          pending.decl.loc,
          'compile/self-relationship',
          `\`${sourceId}\` cannot depend on itself.`,
        );
        continue;
      }

      const attributes = this.#readRelationProperties(pending.decl);
      drafts.push({
        sourceId,
        destId,
        description: pending.decl.description ?? attributes.description,
        technology: attributes.technology,
        protocol: attributes.protocol,
        bidirectional: pending.decl.bidirectional,
        tags: attributes.tags,
        properties: attributes.properties,
        loc: pending.decl.loc,
      });
    }

    // Stable relationship ids: the endpoint pair alone when unique, otherwise
    // disambiguated by a slug of the description, then by ordinal. This keeps
    // ids unchanged when unrelated relationships are added elsewhere.
    const byPair = new Map<string, Draft[]>();
    for (const draft of drafts) {
      const key = `${draft.sourceId}->${draft.destId}`;
      const group = byPair.get(key) ?? [];
      group.push(draft);
      byPair.set(key, group);
    }

    const relations: Relation[] = [];
    for (const [key, group] of byPair) {
      const used = new Set<string>();
      group.forEach((draft, index) => {
        let id = key;
        if (group.length > 1) {
          const discriminator = slug(draft.description ?? '') || String(index + 1);
          id = `${key}#${discriminator}`;
          let suffix = 2;
          while (used.has(id)) {
            id = `${key}#${discriminator}-${suffix}`;
            suffix += 1;
          }
        }
        used.add(id);
        relations.push({
          id,
          sourceId: draft.sourceId,
          destId: draft.destId,
          description: draft.description,
          technology: draft.technology,
          protocol: draft.protocol,
          direction: draft.bidirectional ? 'bi' : 'uni',
          tags: normalizeTags(draft.tags),
          properties: draft.properties,
          provenance: { source: 'declared', loc: draft.loc },
        });
      });
    }

    return sortBy(relations, (r) => r.id);
  }

  #readRelationProperties(decl: AstRelationDecl): {
    description?: string;
    technology?: string;
    protocol?: string;
    tags: string[];
    properties: Record<string, string>;
  } {
    const tags: string[] = [];
    const properties: Record<string, string> = {};
    let description: string | undefined;
    let technology: string | undefined;
    let protocol: string | undefined;

    for (const statement of decl.body) {
      if (statement.kind !== 'property') continue;
      if (!KNOWN_RELATION_PROPERTIES.has(statement.name)) {
        this.#unknownProperty(statement, KNOWN_RELATION_PROPERTIES);
        continue;
      }
      switch (statement.name) {
        case 'description':
          description = this.#text(statement, 0);
          break;
        case 'technology':
        case 'tech':
          technology = this.#text(statement, 0);
          break;
        case 'protocol':
          protocol = this.#text(statement, 0);
          break;
        case 'tag':
        case 'tags':
          for (const arg of statement.args) tags.push(argText(arg));
          break;
        case 'prop':
        case 'property': {
          const key = this.#text(statement, 0);
          if (key) properties[key] = this.#text(statement, 1) ?? '';
          break;
        }
      }
    }
    return { description, technology, protocol, tags, properties };
  }

  /** Deployment nodes referencing containers are checked after declaration. */
  #resolveInstanceRefs(): void {
    for (const [id, element] of [...this.#elements]) {
      if (!element.instanceOf) continue;
      const ref: AstRef = {
        path: element.instanceOf.split('.'),
        loc: (element.provenance.source === 'declared' && element.provenance.loc) || {
          file: '<unknown>',
          line: 0,
          column: 0,
        },
      };
      const resolved = this.#resolveRef(ref, this.#scopeChain(id));
      if (!resolved) continue;
      const target = this.#elements.get(resolved);
      if (target && target.kind !== 'container' && target.kind !== 'component') {
        this.#error(
          ref.loc,
          'compile/invalid-instance',
          `\`instanceOf\` must point at a container or component, not a ${target.kind}.`,
        );
        continue;
      }
      this.#elements.set(id, { ...element, instanceOf: resolved });
    }
  }

  // ------------------------------------------------------------------- views

  #declareView(decl: AstViewDecl): void {
    const kind = decl.viewKind as ViewKind;
    let scopeId: string | undefined;

    if (decl.scope) {
      scopeId = this.#resolveRef(decl.scope, []);
      if (!scopeId) return;
    } else if (kind === 'container' || kind === 'component') {
      this.#error(
        decl.loc,
        'compile/missing-view-scope',
        `A ${kind} view needs a scope.`,
        `Write \`${kind} ${decl.id} "<title>" of <ref>\`.`,
      );
      return;
    }

    if (scopeId) {
      const scope = this.#elements.get(scopeId);
      const expected: Readonly<Record<string, ElementKind | undefined>> = {
        context: 'system',
        container: 'system',
        component: 'container',
        deployment: 'deploymentNode',
        dynamic: undefined,
      };
      const want = expected[kind];
      if (want && scope && scope.kind !== want) {
        this.#error(
          decl.loc,
          'compile/invalid-view-scope',
          `A ${kind} view must be scoped to a ${want}, but \`${scopeId}\` is a ${scope.kind}.`,
        );
        return;
      }
    }

    const include: string[] = [];
    const exclude: string[] = [];
    const steps: DynamicStep[] = [];
    let title = decl.title;

    for (const statement of decl.body) {
      if (statement.kind === 'property') {
        switch (statement.name) {
          case 'include':
            include.push(this.#text(statement, 0) ?? '*');
            break;
          case 'exclude':
            exclude.push(this.#text(statement, 0) ?? '*');
            break;
          case 'title':
            title = this.#text(statement, 0) ?? title;
            break;
          case 'description':
            break;
          default:
            this.#error(
              statement.loc,
              'compile/unknown-property',
              `\`${statement.name}\` is not valid inside a view.`,
              'Views accept `include`, `exclude` and `title`.',
            );
        }
        continue;
      }
      if (statement.kind === 'relation') {
        if (kind !== 'dynamic') {
          this.#error(
            statement.loc,
            'compile/misplaced-step',
            'Interaction steps are only allowed in a `dynamic` view.',
          );
          continue;
        }
        const sourceId = this.#resolveRef(statement.source, []);
        const destId = this.#resolveRef(statement.dest, []);
        if (!sourceId || !destId) continue;
        steps.push({
          order: steps.length + 1,
          sourceId,
          destId,
          description: statement.description,
        });
      }
    }

    if (kind === 'dynamic' && steps.length === 0) {
      this.#error(decl.loc, 'compile/empty-dynamic-view', `Dynamic view \`${decl.id}\` has no steps.`);
      return;
    }

    if (this.#views.some((v) => v.id === decl.id)) {
      this.#error(decl.loc, 'compile/duplicate-id', `View \`${decl.id}\` is already defined.`);
      return;
    }

    this.#views.push({
      id: decl.id,
      kind,
      title: title ?? decl.id,
      scopeId,
      include,
      exclude,
      steps,
      loc: decl.loc,
    });
  }

  // ------------------------------------------------------------------- rules

  #declareRule(decl: AstRuleDecl): void {
    let severity: Severity = 'error';
    const assertions: Assertion[] = [];

    for (const statement of decl.body) {
      switch (statement.type) {
        case 'severity': {
          if (statement.value === 'error' || statement.value === 'warning' || statement.value === 'info') {
            severity = statement.value;
          } else {
            this.#error(
              statement.loc,
              'compile/invalid-severity',
              `Unknown severity \`${statement.value}\`.`,
              'Expected `error`, `warning` or `info`.',
            );
          }
          break;
        }
        case 'dependency':
          assertions.push(
            statement.mode === 'forbid'
              ? { type: 'forbidDependency', from: statement.from, to: statement.to }
              : { type: 'allowDependency', from: statement.from, to: statement.to },
          );
          break;
        case 'require': {
          if (!REQUIRABLE_FIELDS.has(statement.field)) {
            this.#error(
              statement.loc,
              'compile/invalid-required-field',
              `Cannot require \`${statement.field}\`.`,
              `Expected one of: ${[...REQUIRABLE_FIELDS].sort().join(', ')}.`,
            );
            break;
          }
          assertions.push({
            type: 'requireField',
            field: statement.field as RequirableField,
            on: statement.on,
          });
          break;
        }
        case 'forbidCycles':
          assertions.push({ type: 'forbidCycles', within: statement.within });
          break;
        case 'forbidOrphans':
          assertions.push({ type: 'forbidOrphans', within: statement.within });
          break;
      }
    }

    if (assertions.length === 0) {
      this.#error(
        decl.loc,
        'compile/empty-rule',
        `Rule \`${decl.id}\` has no assertions and will never fire.`,
      );
      return;
    }
    if (this.#rules.some((r) => r.id === decl.id)) {
      this.#error(decl.loc, 'compile/duplicate-id', `Rule \`${decl.id}\` is already defined.`);
      return;
    }

    this.#rules.push({ id: decl.id, title: decl.title, severity, assertions, loc: decl.loc });
  }

  // ------------------------------------------------------------------- utils

  #text(statement: AstPropertyStmt, index: number): string | undefined {
    const arg = statement.args[index];
    if (!arg) return undefined;
    return argText(arg);
  }

  #refText(statement: AstPropertyStmt, index: number): string | undefined {
    const arg = statement.args[index];
    if (!arg) return undefined;
    if (arg.type === 'ref') return arg.value.path.join('.');
    return argText(arg);
  }

  #unknownProperty(statement: AstPropertyStmt, known: ReadonlySet<string>): void {
    const suggestion = [...known]
      .map((name) => ({ name, score: editDistance(statement.name, name) }))
      .filter((c) => c.score <= 2)
      .sort((a, b) => a.score - b.score || (a.name < b.name ? -1 : 1))[0];
    this.#error(
      statement.loc,
      'compile/unknown-property',
      `Unknown property \`${statement.name}\`.`,
      suggestion ? `Did you mean \`${suggestion.name}\`?` : `Known properties: ${[...known].sort().join(', ')}.`,
    );
  }

  #error(loc: SourceLoc, code: string, message: string, hint?: string): void {
    this.#diagnostics.push(diag('error', code, message, loc, hint));
  }
}

function argText(arg: AstPropertyArg): string {
  if (arg.type === 'ref') return arg.value.path.join('.');
  return arg.value;
}

/** Repository paths are stored POSIX-style and without a leading `./`. */
function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Levenshtein distance, capped in practice by the callers' score filters. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = new Array<number>(cols);
  let current = new Array<number>(cols);
  for (let j = 0; j < cols; j += 1) previous[j] = j;
  for (let i = 1; i < rows; i += 1) {
    current[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[cols - 1] ?? 0;
}
