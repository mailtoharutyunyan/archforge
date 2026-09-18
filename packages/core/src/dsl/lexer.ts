/**
 * Hand-written lexer for the architecture DSL.
 *
 * Hand-written rather than generated because error messages are a feature
 * here: this language is edited by humans in an editor and by agents in a
 * loop, and both need to be told exactly where they went wrong.
 */

import { diag, type Diagnostic } from '../diagnostics.ts';
import type { SourceLoc } from '../model/types.ts';

export type TokenType =
  | 'ident'
  | 'string'
  | 'number'
  | 'arrow' // ->
  | 'biarrow' // <->
  | 'lbrace'
  | 'rbrace'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'comma'
  | 'colon'
  | 'semi'
  | 'dot'
  | 'star'
  | 'eof';

export interface Token {
  readonly type: TokenType;
  /** Source text for idents/numbers, decoded value for strings. */
  readonly value: string;
  readonly loc: SourceLoc;
}

export interface LexResult {
  readonly tokens: readonly Token[];
  readonly diagnostics: readonly Diagnostic[];
}

const SINGLE_CHAR: Readonly<Record<string, TokenType>> = {
  '{': 'lbrace',
  '}': 'rbrace',
  '(': 'lparen',
  ')': 'rparen',
  '[': 'lbracket',
  ']': 'rbracket',
  ',': 'comma',
  ':': 'colon',
  ';': 'semi',
  '.': 'dot',
  '*': 'star',
};

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_-]/;

export function lex(source: string, file: string): LexResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];

  let index = 0;
  let line = 1;
  let column = 1;

  const here = (): SourceLoc => ({ file, line, column });

  const advance = (count = 1): void => {
    for (let i = 0; i < count && index < source.length; i += 1) {
      if (source[index] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      index += 1;
    }
  };

  const push = (type: TokenType, value: string, loc: SourceLoc): void => {
    tokens.push({ type, value, loc });
  };

  while (index < source.length) {
    const char = source[index] as string;

    // Whitespace, including newlines: the grammar is brace-delimited, so
    // layout carries no meaning and authors can format freely.
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      advance();
      continue;
    }

    // Comments: `//` and `#` to end of line, `/* */` nesting-free block.
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') advance();
      continue;
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') advance();
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const start = here();
      advance(2);
      let closed = false;
      while (index < source.length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          advance(2);
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        diagnostics.push(
          diag('error', 'lex/unterminated-comment', 'Unterminated block comment.', start),
        );
      }
      continue;
    }

    // Arrows. `<->` must be tested before `<` would be rejected.
    if (char === '-' && source[index + 1] === '>') {
      const loc = here();
      advance(2);
      push('arrow', '->', loc);
      continue;
    }
    if (char === '<' && source[index + 1] === '-' && source[index + 2] === '>') {
      const loc = here();
      advance(3);
      push('biarrow', '<->', loc);
      continue;
    }

    const single = SINGLE_CHAR[char];
    if (single) {
      const loc = here();
      advance();
      push(single, char, loc);
      continue;
    }

    // Strings. Double-quoted, plus `"""` blocks for multi-line prose so that
    // descriptions and ADR text do not need escaping.
    if (char === '"') {
      const loc = here();
      if (source.startsWith('"""', index)) {
        advance(3);
        const start = index;
        let closed = false;
        while (index < source.length) {
          if (source.startsWith('"""', index)) {
            closed = true;
            break;
          }
          advance();
        }
        const raw = source.slice(start, index);
        if (!closed) {
          diagnostics.push(
            diag('error', 'lex/unterminated-string', 'Unterminated """ block string.', loc),
          );
        } else {
          advance(3);
        }
        push('string', dedent(raw), loc);
        continue;
      }
      advance();
      let value = '';
      let closed = false;
      while (index < source.length) {
        const c = source[index] as string;
        if (c === '\\') {
          const next = source[index + 1];
          if (next === undefined) break;
          value += unescape(next);
          advance(2);
          continue;
        }
        if (c === '"') {
          advance();
          closed = true;
          break;
        }
        if (c === '\n') break; // Report at the opening quote rather than running on.
        value += c;
        advance();
      }
      if (!closed) {
        diagnostics.push(
          diag(
            'error',
            'lex/unterminated-string',
            'Unterminated string literal.',
            loc,
            'Add a closing double quote, or use """ ... """ for multi-line text.',
          ),
        );
      }
      push('string', value, loc);
      continue;
    }

    if (/[0-9]/.test(char)) {
      const loc = here();
      let value = '';
      while (index < source.length && /[0-9._]/.test(source[index] as string)) {
        value += source[index];
        advance();
      }
      push('number', value, loc);
      continue;
    }

    if (IDENT_START.test(char)) {
      const loc = here();
      let value = '';
      while (index < source.length && IDENT_PART.test(source[index] as string)) {
        value += source[index];
        advance();
      }
      push('ident', value, loc);
      continue;
    }

    const loc = here();
    advance();
    diagnostics.push(
      diag('error', 'lex/unexpected-character', `Unexpected character ${JSON.stringify(char)}.`, loc),
    );
  }

  push('eof', '', here());
  return { tokens, diagnostics };
}

function unescape(char: string): string {
  switch (char) {
    case 'n':
      return '\n';
    case 't':
      return '\t';
    case 'r':
      return '\r';
    case '"':
      return '"';
    case '\\':
      return '\\';
    default:
      return char;
  }
}

/**
 * Removes the common leading indentation from a `"""` block so that prose
 * indented to match surrounding code does not carry that indentation into the
 * model (and therefore into rendered documentation).
 */
function dedent(raw: string): string {
  const lines = raw.replace(/^\n/, '').replace(/\s+$/, '').split('\n');
  let common = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const indent = line.length - line.trimStart().length;
    common = Math.min(common, indent);
  }
  if (!Number.isFinite(common)) common = 0;
  return lines.map((line) => line.slice(common)).join('\n');
}
