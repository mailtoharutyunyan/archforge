/**
 * Concrete syntax tree for the DSL.
 *
 * The AST keeps the shape of what the author wrote, including source
 * locations. Turning it into a semantic model — resolving references,
 * qualifying identifiers, checking uniqueness — is the compiler's job, which
 * keeps parse errors and semantic errors reportable at separate stages.
 */

import type { SourceLoc } from '../model/types.ts';

export interface AstNode {
  readonly loc: SourceLoc;
}

export interface AstWorkspace extends AstNode {
  readonly kind: 'workspace';
  readonly name: string;
  readonly body: readonly AstStatement[];
}

export type AstStatement =
  | AstElementDecl
  | AstRelationDecl
  | AstPropertyStmt
  | AstViewsBlock
  | AstRulesBlock;

/**
 * A declaration such as `container api "Payment API" { ... }`.
 * `keyword` is kept verbatim so the compiler owns the keyword-to-kind mapping.
 */
export interface AstElementDecl extends AstNode {
  readonly kind: 'element';
  readonly keyword: string;
  readonly id: string;
  readonly name?: string;
  readonly body: readonly AstStatement[];
}

export interface AstRef extends AstNode {
  /** Dotted path exactly as written, e.g. `payments.api`. */
  readonly path: readonly string[];
}

export interface AstRelationDecl extends AstNode {
  readonly kind: 'relation';
  readonly source: AstRef;
  readonly dest: AstRef;
  readonly bidirectional: boolean;
  readonly description?: string;
  readonly body: readonly AstStatement[];
}

/** `description "..."`, `tag a, b`, `prop team "payments"`. */
export interface AstPropertyStmt extends AstNode {
  readonly kind: 'property';
  readonly name: string;
  readonly args: readonly AstPropertyArg[];
}

export type AstPropertyArg =
  | { readonly type: 'string'; readonly value: string; readonly loc: SourceLoc }
  | { readonly type: 'ident'; readonly value: string; readonly loc: SourceLoc }
  | { readonly type: 'number'; readonly value: string; readonly loc: SourceLoc }
  | { readonly type: 'ref'; readonly value: AstRef; readonly loc: SourceLoc };

export interface AstViewsBlock extends AstNode {
  readonly kind: 'views';
  readonly views: readonly AstViewDecl[];
}

export interface AstViewDecl extends AstNode {
  /** `context` | `container` | `component` | `deployment` | `dynamic`. */
  readonly viewKind: string;
  readonly id: string;
  readonly title?: string;
  readonly scope?: AstRef;
  readonly body: readonly AstStatement[];
}

export interface AstRulesBlock extends AstNode {
  readonly kind: 'rules';
  readonly rules: readonly AstRuleDecl[];
}

export interface AstRuleDecl extends AstNode {
  readonly id: string;
  readonly title?: string;
  readonly body: readonly AstRuleStatement[];
}

export type AstRuleStatement =
  | { readonly type: 'severity'; readonly value: string; readonly loc: SourceLoc }
  | {
      readonly type: 'dependency';
      readonly mode: 'forbid' | 'allow';
      readonly from: string;
      readonly to: string;
      readonly loc: SourceLoc;
    }
  | {
      readonly type: 'require';
      readonly field: string;
      readonly on: string;
      readonly loc: SourceLoc;
    }
  | {
      readonly type: 'forbidCycles';
      readonly within?: string;
      readonly loc: SourceLoc;
    }
  | {
      readonly type: 'forbidOrphans';
      readonly within?: string;
      readonly loc: SourceLoc;
    };
