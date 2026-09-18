/**
 * Recursive-descent parser for the architecture DSL.
 *
 * Design notes that matter for anyone extending the grammar:
 *
 *  - Layout is insignificant. Statements are not newline-terminated; instead
 *    every property statement has a known arity, and the two variadic ones
 *    (`tag`, `tags`) use comma separation. That keeps `technology "Java"`
 *    followed by `tag internal` unambiguous without the parser having to track
 *    line breaks, which in turn lets authors and agents reformat freely.
 *  - The parser never throws on bad input. It records a diagnostic, skips to a
 *    plausible recovery point, and keeps going, so one typo does not hide the
 *    other nine problems in the file.
 *  - Selectors are captured as canonical source strings and parsed by
 *    `selector.ts`. The string form is what gets stored in the model, which
 *    makes rules diffable and readable in JSON output.
 */

import { diag, type Diagnostic } from '../diagnostics.ts';
import type { SourceLoc } from '../model/types.ts';
import type {
  AstElementDecl,
  AstPropertyArg,
  AstPropertyStmt,
  AstRef,
  AstRelationDecl,
  AstRuleDecl,
  AstRuleStatement,
  AstStatement,
  AstViewDecl,
} from './ast.ts';
import { lex, type Token, type TokenType } from './lexer.ts';

/** Keywords that introduce an element declaration. */
export const ELEMENT_KEYWORDS: readonly string[] = [
  'person',
  'actor',
  'system',
  'softwareSystem',
  'container',
  'component',
  'database',
  'queue',
  'topic',
  'api',
  'service',
  'browser',
  'mobileApp',
  'function',
  'cache',
  'deploymentNode',
  'node',
  'infrastructureNode',
  'infra',
];

export const VIEW_KEYWORDS: readonly string[] = [
  'context',
  'container',
  'component',
  'deployment',
  'dynamic',
];

/**
 * Fixed arity for known property statements. `-1` means "variadic,
 * comma-separated". Unknown names are parsed as variadic and rejected later by
 * the compiler, so a misspelling produces a semantic error with a suggestion
 * rather than a confusing parse failure.
 */
const PROPERTY_ARITY: Readonly<Record<string, number>> = {
  description: 1,
  technology: 1,
  tech: 1,
  owner: 1,
  team: 1,
  url: 1,
  kind: 1,
  subtype: 1,
  icon: 1,
  source: 1,
  instanceOf: 1,
  instances: 1,
  title: 1,
  protocol: 1,
  include: 1,
  exclude: 1,
  external: 0,
  prop: 2,
  property: 2,
  tag: -1,
  tags: -1,
};

export interface ParseResult {
  readonly statements: readonly AstStatement[];
  readonly workspaceName?: string;
  readonly workspaceLoc?: SourceLoc;
  readonly diagnostics: readonly Diagnostic[];
}

export function parse(source: string, file: string): ParseResult {
  const lexed = lex(source, file);
  const parser = new Parser(lexed.tokens, [...lexed.diagnostics]);
  return parser.parseFile();
}

class Parser {
  readonly #tokens: readonly Token[];
  readonly #diagnostics: Diagnostic[];
  #pos = 0;

  constructor(tokens: readonly Token[], diagnostics: Diagnostic[]) {
    this.#tokens = tokens;
    this.#diagnostics = diagnostics;
  }

  parseFile(): ParseResult {
    let workspaceName: string | undefined;
    let workspaceLoc: SourceLoc | undefined;
    const statements: AstStatement[] = [];

    while (!this.#check('eof')) {
      const before = this.#pos;

      if (this.#checkIdent('workspace')) {
        const keyword = this.#advance();
        workspaceLoc = keyword.loc;
        if (this.#check('string')) workspaceName = this.#advance().value;
        if (this.#check('lbrace')) {
          statements.push(...this.#parseBlock());
        }
      } else {
        const statement = this.#parseStatement();
        if (statement) statements.push(statement);
      }

      // Guarantee forward progress even when recovery finds nothing useful.
      if (this.#pos === before) this.#advance();
    }

    return { statements, workspaceName, workspaceLoc, diagnostics: this.#diagnostics };
  }

  // ---------------------------------------------------------------- statements

  #parseStatement(): AstStatement | undefined {
    if (this.#check('semi')) {
      this.#advance();
      return undefined;
    }

    if (this.#checkIdent('views') && this.#peekIs(1, 'lbrace')) {
      return this.#parseViewsBlock();
    }
    if (this.#checkIdent('rules') && this.#peekIs(1, 'lbrace')) {
      return this.#parseRulesBlock();
    }

    // A relationship starts with a reference; look ahead past the dotted path
    // for an arrow before committing.
    if (this.#check('ident') && this.#arrowFollowsRef()) {
      return this.#parseRelation();
    }

    if (this.#check('ident')) {
      const word = this.#current().value;
      if (ELEMENT_KEYWORDS.includes(word) && this.#peekIs(1, 'ident')) {
        return this.#parseElement();
      }
      return this.#parsePropertyStatement();
    }

    this.#errorHere(
      'parse/unexpected-token',
      `Unexpected ${describe(this.#current())}.`,
      'Expected a declaration such as `system`, `container`, a relationship like `a -> b`, or a property.',
    );
    this.#recoverToStatementBoundary();
    return undefined;
  }

  #parseElement(): AstElementDecl {
    const keyword = this.#advance();
    const id = this.#expect('ident', 'an identifier for this element');
    const name = this.#check('string') ? this.#advance().value : undefined;
    const body = this.#check('lbrace') ? this.#parseBlock() : [];
    const decl: AstElementDecl = {
      kind: 'element',
      keyword: keyword.value,
      id: id?.value ?? '<missing>',
      name,
      body,
      loc: keyword.loc,
    };
    return decl;
  }

  #parseRelation(): AstRelationDecl {
    const source = this.#parseRef();
    const bidirectional = this.#check('biarrow');
    const arrow = this.#advance(); // arrow or biarrow, guaranteed by lookahead
    if (arrow.type !== 'arrow' && arrow.type !== 'biarrow') {
      this.#error(arrow.loc, 'parse/expected-arrow', 'Expected `->` or `<->`.');
    }
    const dest = this.#parseRef();
    const description = this.#check('string') ? this.#advance().value : undefined;
    const body = this.#check('lbrace') ? this.#parseBlock() : [];
    return {
      kind: 'relation',
      source,
      dest,
      bidirectional,
      description,
      body,
      loc: source.loc,
    };
  }

  #parsePropertyStatement(): AstPropertyStmt {
    const name = this.#advance();
    const arity = PROPERTY_ARITY[name.value] ?? -1;
    const args: AstPropertyArg[] = [];

    if (name.value === 'include' || name.value === 'exclude') {
      const selector = this.#parseSelectorSource();
      args.push({ type: 'string', value: selector.text, loc: selector.loc });
    } else if (arity === -1) {
      // Variadic, comma-separated: `tag internal, critical`.
      if (this.#canStartArg()) {
        args.push(this.#parseArg());
        while (this.#check('comma')) {
          this.#advance();
          if (!this.#canStartArg()) {
            this.#errorHere('parse/expected-argument', 'Expected a value after `,`.');
            break;
          }
          args.push(this.#parseArg());
        }
      }
    } else {
      for (let i = 0; i < arity; i += 1) {
        if (!this.#canStartArg()) {
          this.#errorHere(
            'parse/missing-argument',
            `\`${name.value}\` expects ${arity} value${arity === 1 ? '' : 's'}, found ${i}.`,
          );
          break;
        }
        args.push(this.#parseArg());
      }
    }

    if (this.#check('semi')) this.#advance();
    return { kind: 'property', name: name.value, args, loc: name.loc };
  }

  // -------------------------------------------------------------------- views

  #parseViewsBlock(): AstStatement {
    const keyword = this.#advance();
    const views: AstViewDecl[] = [];
    this.#expect('lbrace', '`{` to open the views block');

    while (!this.#check('rbrace') && !this.#check('eof')) {
      const before = this.#pos;
      if (this.#check('ident')) {
        const viewKind = this.#current().value;
        if (VIEW_KEYWORDS.includes(viewKind)) {
          views.push(this.#parseViewDecl());
        } else {
          this.#errorHere(
            'parse/unknown-view-kind',
            `Unknown view kind \`${viewKind}\`.`,
            `Expected one of: ${VIEW_KEYWORDS.join(', ')}.`,
          );
          this.#recoverToStatementBoundary();
        }
      } else {
        this.#errorHere('parse/unexpected-token', `Unexpected ${describe(this.#current())} in views block.`);
        this.#recoverToStatementBoundary();
      }
      if (this.#pos === before) this.#advance();
    }
    this.#expect('rbrace', '`}` to close the views block');
    return { kind: 'views', views, loc: keyword.loc };
  }

  #parseViewDecl(): AstViewDecl {
    const keyword = this.#advance();
    const id = this.#expect('ident', 'an identifier for this view');
    const title = this.#check('string') ? this.#advance().value : undefined;
    let scope: AstRef | undefined;
    if (this.#checkIdent('of')) {
      this.#advance();
      scope = this.#parseRef();
    }
    const body = this.#check('lbrace') ? this.#parseBlock() : [];
    return {
      viewKind: keyword.value,
      id: id?.value ?? '<missing>',
      title,
      scope,
      body,
      loc: keyword.loc,
    };
  }

  // -------------------------------------------------------------------- rules

  #parseRulesBlock(): AstStatement {
    const keyword = this.#advance();
    const rules: AstRuleDecl[] = [];
    this.#expect('lbrace', '`{` to open the rules block');

    while (!this.#check('rbrace') && !this.#check('eof')) {
      const before = this.#pos;
      if (this.#checkIdent('rule')) {
        rules.push(this.#parseRuleDecl());
      } else {
        this.#errorHere(
          'parse/unexpected-token',
          `Unexpected ${describe(this.#current())} in rules block.`,
          'Each entry must start with `rule <id>`.',
        );
        this.#recoverToStatementBoundary();
      }
      if (this.#pos === before) this.#advance();
    }
    this.#expect('rbrace', '`}` to close the rules block');
    return { kind: 'rules', rules, loc: keyword.loc };
  }

  #parseRuleDecl(): AstRuleDecl {
    const keyword = this.#advance();
    const id = this.#expect('ident', 'an identifier for this rule');
    const title = this.#check('string') ? this.#advance().value : undefined;
    const body: AstRuleStatement[] = [];

    this.#expect('lbrace', '`{` to open the rule body');
    while (!this.#check('rbrace') && !this.#check('eof')) {
      const before = this.#pos;
      const statement = this.#parseRuleStatement();
      if (statement) body.push(statement);
      if (this.#pos === before) this.#advance();
    }
    this.#expect('rbrace', '`}` to close the rule body');

    return { id: id?.value ?? '<missing>', title, body, loc: keyword.loc };
  }

  #parseRuleStatement(): AstRuleStatement | undefined {
    if (this.#check('semi')) {
      this.#advance();
      return undefined;
    }
    if (!this.#check('ident')) {
      this.#errorHere('parse/unexpected-token', `Unexpected ${describe(this.#current())} in rule body.`);
      this.#recoverToStatementBoundary();
      return undefined;
    }

    const keyword = this.#advance();
    switch (keyword.value) {
      case 'severity': {
        const value = this.#expect('ident', 'one of `error`, `warning`, `info`');
        return { type: 'severity', value: value?.value ?? 'error', loc: keyword.loc };
      }
      case 'forbid':
      case 'allow': {
        const mode = keyword.value === 'allow' ? 'allow' : 'forbid';
        if (this.#checkIdent('cycles') || this.#checkIdent('orphans')) {
          const what = this.#advance().value;
          let within: string | undefined;
          if (this.#checkIdent('in')) {
            this.#advance();
            within = this.#parseSelectorSource().text;
          }
          if (mode === 'allow') {
            this.#error(
              keyword.loc,
              'parse/unsupported-assertion',
              `\`allow ${what}\` is not meaningful; use \`forbid ${what}\`.`,
            );
            return undefined;
          }
          return what === 'cycles'
            ? { type: 'forbidCycles', within, loc: keyword.loc }
            : { type: 'forbidOrphans', within, loc: keyword.loc };
        }
        const from = this.#parseSelectorSource();
        if (this.#check('arrow') || this.#check('biarrow')) {
          this.#advance();
        } else {
          this.#errorHere(
            'parse/expected-arrow',
            'Expected `->` between the two sides of a dependency assertion.',
          );
        }
        const to = this.#parseSelectorSource();
        return { type: 'dependency', mode, from: from.text, to: to.text, loc: keyword.loc };
      }
      case 'require': {
        const field = this.#expect('ident', 'a field name such as `owner` or `technology`');
        if (this.#checkIdent('on')) this.#advance();
        const on = this.#parseSelectorSource();
        return {
          type: 'require',
          field: field?.value ?? '<missing>',
          on: on.text,
          loc: keyword.loc,
        };
      }
      default:
        this.#error(
          keyword.loc,
          'parse/unknown-rule-statement',
          `Unknown rule statement \`${keyword.value}\`.`,
          'Expected `severity`, `forbid`, `allow`, or `require`.',
        );
        this.#recoverToStatementBoundary();
        return undefined;
    }
  }

  // ---------------------------------------------------------------- selectors

  /**
   * Reads a selector and returns its canonical text. Accepted forms:
   *   `*`                       — everything
   *   `element(tag:internal)`   — conjunction of predicates
   *   `tag:internal`            — shorthand for a single predicate
   */
  #parseSelectorSource(): { text: string; loc: SourceLoc } {
    const loc = this.#current().loc;

    if (this.#check('star')) {
      this.#advance();
      return { text: '*', loc };
    }

    const predicates: string[] = [];
    const readPredicate = (): void => {
      const key = this.#expect('ident', 'a predicate name such as `tag`, `kind` or `id`');
      this.#expect('colon', '`:` between the predicate name and its value');
      let value = '';
      if (this.#check('string')) {
        value = JSON.stringify(this.#advance().value);
      } else if (this.#check('star')) {
        this.#advance();
        value = '*';
      } else if (this.#check('ident')) {
        value = this.#parseRef().path.join('.');
      } else {
        this.#errorHere('parse/expected-selector-value', 'Expected a value after `:`.');
      }
      predicates.push(`${key?.value ?? '<missing>'}:${value}`);
    };

    if (this.#checkIdent('element')) {
      this.#advance();
      this.#expect('lparen', '`(` after `element`');
      if (!this.#check('rparen')) {
        if (this.#check('star')) {
          this.#advance();
          this.#expect('rparen', '`)` to close the selector');
          return { text: '*', loc };
        }
        readPredicate();
        while (this.#check('comma')) {
          this.#advance();
          readPredicate();
        }
      }
      this.#expect('rparen', '`)` to close the selector');
    } else if (this.#check('ident') && this.#peekIs(1, 'colon')) {
      readPredicate();
    } else {
      this.#errorHere(
        'parse/expected-selector',
        `Expected a selector, found ${describe(this.#current())}.`,
        'Write `*`, `tag:internal`, or `element(kind:container, tag:internal)`.',
      );
      return { text: '*', loc };
    }

    if (predicates.length === 0) return { text: '*', loc };
    return { text: `element(${[...predicates].sort().join(',')})`, loc };
  }

  // --------------------------------------------------------------- primitives

  #parseBlock(): AstStatement[] {
    const statements: AstStatement[] = [];
    this.#expect('lbrace', '`{`');
    while (!this.#check('rbrace') && !this.#check('eof')) {
      const before = this.#pos;
      const statement = this.#parseStatement();
      if (statement) statements.push(statement);
      if (this.#pos === before) this.#advance();
    }
    this.#expect('rbrace', '`}`');
    return statements;
  }

  #parseRef(): AstRef {
    const first = this.#expect('ident', 'a reference such as `payments.api`');
    const path: string[] = [first?.value ?? '<missing>'];
    const loc = first?.loc ?? this.#current().loc;
    while (this.#check('dot')) {
      this.#advance();
      const next = this.#expect('ident', 'an identifier after `.`');
      path.push(next?.value ?? '<missing>');
    }
    return { path, loc };
  }

  #parseArg(): AstPropertyArg {
    const token = this.#current();
    if (token.type === 'string') {
      this.#advance();
      return { type: 'string', value: token.value, loc: token.loc };
    }
    if (token.type === 'number') {
      this.#advance();
      return { type: 'number', value: token.value, loc: token.loc };
    }
    const ref = this.#parseRef();
    if (ref.path.length > 1) {
      return { type: 'ref', value: ref, loc: ref.loc };
    }
    return { type: 'ident', value: ref.path[0] ?? '<missing>', loc: ref.loc };
  }

  #canStartArg(): boolean {
    return this.#check('string') || this.#check('number') || this.#check('ident');
  }

  /**
   * True when the tokens starting at the cursor form `ident(.ident)*` followed
   * by an arrow. Used to tell `a.b -> c` apart from `container a "..."`.
   */
  #arrowFollowsRef(): boolean {
    let offset = 0;
    if (!this.#peekIs(offset, 'ident')) return false;
    offset += 1;
    while (this.#peekIs(offset, 'dot') && this.#peekIs(offset + 1, 'ident')) {
      offset += 2;
    }
    return this.#peekIs(offset, 'arrow') || this.#peekIs(offset, 'biarrow');
  }

  /**
   * Skips forward to somewhere a new statement plausibly begins. Stopping at
   * braces keeps an error inside one block from cascading into the next.
   */
  #recoverToStatementBoundary(): void {
    while (!this.#check('eof')) {
      if (this.#check('rbrace') || this.#check('lbrace') || this.#check('semi')) return;
      this.#advance();
      if (this.#check('ident')) {
        const word = this.#current().value;
        if (
          ELEMENT_KEYWORDS.includes(word) ||
          word === 'views' ||
          word === 'rules' ||
          word === 'rule' ||
          PROPERTY_ARITY[word] !== undefined
        ) {
          return;
        }
      }
    }
  }

  #current(): Token {
    return this.#tokens[Math.min(this.#pos, this.#tokens.length - 1)] as Token;
  }

  #peek(offset: number): Token {
    return this.#tokens[Math.min(this.#pos + offset, this.#tokens.length - 1)] as Token;
  }

  #peekIs(offset: number, type: TokenType): boolean {
    return this.#peek(offset).type === type;
  }

  #check(type: TokenType): boolean {
    return this.#current().type === type;
  }

  #checkIdent(word: string): boolean {
    return this.#check('ident') && this.#current().value === word;
  }

  #advance(): Token {
    const token = this.#current();
    if (this.#pos < this.#tokens.length - 1) this.#pos += 1;
    return token;
  }

  #expect(type: TokenType, what: string): Token | undefined {
    if (this.#check(type)) return this.#advance();
    this.#errorHere('parse/expected-token', `Expected ${what}, found ${describe(this.#current())}.`);
    return undefined;
  }

  #errorHere(code: string, message: string, hint?: string): void {
    this.#error(this.#current().loc, code, message, hint);
  }

  #error(loc: SourceLoc, code: string, message: string, hint?: string): void {
    // One diagnostic per source position keeps cascading failures readable.
    const duplicate = this.#diagnostics.some(
      (d) => d.loc?.line === loc.line && d.loc?.column === loc.column && d.code === code,
    );
    if (duplicate) return;
    this.#diagnostics.push(diag('error', code, message, loc, hint));
  }
}

function describe(token: Token): string {
  switch (token.type) {
    case 'eof':
      return 'end of file';
    case 'string':
      return `string ${JSON.stringify(token.value)}`;
    case 'ident':
      return `\`${token.value}\``;
    default:
      return `\`${token.value}\``;
  }
}
