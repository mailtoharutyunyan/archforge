/**
 * Pieces shared by the full editor and the split view.
 *
 * Extracted rather than copied: the syntax highlighter in particular must
 * agree with the compiler about what a token is, and two copies of it would
 * eventually disagree with each other as well.
 *
 * Everything here is pure or DOM-only — no application state.
 */

import { lex } from '../../core/src/index.ts';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function download(filename: string, content: string, mime = 'text/plain'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking immediately can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Pointer capture, defensively.
 *
 * `setPointerCapture` throws `NotFoundError` whenever the pointer id is no
 * longer active. An uncaught throw inside `pointerdown` would abort the handler
 * before it attached its move and up listeners, leaving the canvas stuck
 * mid-drag. Capture is an optimisation here, not a requirement.
 */
export function capturePointer(target: HTMLElement, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Dragging still works through the listeners.
  }
}

export function releasePointer(target: HTMLElement, pointerId: number): void {
  try {
    target.releasePointerCapture(pointerId);
  } catch {
    // Already released, or never captured.
  }
}

/** Words the editor paints as keywords. Kept in step with the parser. */
export const DSL_KEYWORDS: ReadonlySet<string> = new Set([
  'workspace', 'person', 'actor', 'system', 'softwareSystem', 'container', 'component',
  'database', 'queue', 'topic', 'api', 'service', 'browser', 'mobileApp', 'function', 'cache',
  'deploymentNode', 'node', 'infrastructureNode', 'infra',
  'views', 'rules', 'rule', 'context', 'deployment', 'dynamic', 'of',
  'description', 'technology', 'tech', 'owner', 'team', 'url', 'kind', 'subtype', 'icon',
  'source', 'instanceOf', 'instances', 'title', 'protocol', 'include', 'exclude', 'external',
  'prop', 'property', 'tag', 'tags',
  'severity', 'forbid', 'allow', 'require', 'cycles', 'orphans', 'on', 'in',
  'error', 'warning', 'info', 'element',
]);

/**
 * Highlights DSL source by running the engine's own lexer over it, so the
 * editor can never disagree with the compiler about what a token is.
 *
 * Returns HTML whose text content is byte-identical to the input, which is
 * what keeps the highlighted mirror aligned with the textarea underneath it.
 */
export function highlightSource(source: string): string {
  const { tokens } = lex(source, 'architecture.arch');

  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }
  const offsetOf = (line: number, column: number): number =>
    (lineStarts[line - 1] ?? 0) + column - 1;

  let cursor = 0;
  let html = '';

  for (const token of tokens) {
    if (token.type === 'eof') break;
    const start = offsetOf(token.loc.line, token.loc.column);
    if (start < cursor) continue;

    const gap = source.slice(cursor, start);
    if (gap !== '') html += highlightGap(gap);

    const raw = rawTokenText(source, start, token.type, token.value);
    const className =
      token.type === 'string'
        ? 'tok-string'
        : token.type === 'number'
          ? 'tok-number'
          : token.type === 'arrow' || token.type === 'biarrow'
            ? 'tok-arrow'
            : token.type === 'ident'
              ? DSL_KEYWORDS.has(token.value)
                ? 'tok-keyword'
                : 'tok-ident'
              : 'tok-punct';

    html += `<span class="${className}">${escapeHtml(raw)}</span>`;
    cursor = start + raw.length;
  }

  if (cursor < source.length) html += highlightGap(source.slice(cursor));
  // A trailing newline keeps the mirror's height in step with the textarea.
  return `${html}\n`;
}

/** Comments are the only meaningful content in the gaps between tokens. */
function highlightGap(gap: string): string {
  let out = '';
  const pattern = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(gap)) !== null) {
    out += escapeHtml(gap.slice(last, match.index));
    out += `<span class="tok-comment">${escapeHtml(match[0])}</span>`;
    last = match.index + match[0].length;
  }
  out += escapeHtml(gap.slice(last));
  return out;
}

/**
 * Recovers a token's original text. The lexer decodes string values, so the
 * mirror must re-read the raw slice or the highlighted text would drift out of
 * alignment with the textarea.
 */
function rawTokenText(source: string, start: number, type: string, value: string): string {
  if (type !== 'string') return value;
  if (source.startsWith('"""', start)) {
    const end = source.indexOf('"""', start + 3);
    return end < 0 ? source.slice(start) : source.slice(start, end + 3);
  }
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === '"' || source[index] === '\n') break;
    index += 1;
  }
  return source.slice(start, Math.min(index + 1, source.length));
}

/** Line numbers, with error lines marked. */
export function gutterHtml(source: string, errorLines: ReadonlySet<number>): string {
  const count = source.split('\n').length;
  const parts: string[] = [];
  for (let line = 1; line <= count; line += 1) {
    parts.push(`<span class="${errorLines.has(line) ? 'has-error' : ''}">${line}</span>`);
  }
  return parts.join('');
}

/** The starter model both editors open with. */
export const TEMPLATE = `workspace "My Platform" {

  description "Replace this with what the platform is for."

  person customer "Customer" {
    description "Uses the platform."
  }

  system platform "My Platform" {
    description "The system being described."
    owner "platform-team"

    container web "Web app" {
      technology "TypeScript / React"
      kind browser
    }

    container api "API" {
      technology "Node 22 / Fastify"
      source "services/api"
      tag internal
    }

    database db "Primary database" {
      technology "PostgreSQL 16"
    }
  }

  customer -> platform.web "Uses" { technology "HTTPS" }
  platform.web -> platform.api "Calls" { technology "HTTPS/JSON" }
  platform.api -> platform.db "Reads and writes" { technology "SQL" }

  views {
    context landscape "System landscape" of platform
    container containers "Containers" of platform
  }

  rules {
    rule no-cycles "Architecture must be acyclic" {
      severity error
      forbid cycles
    }

    rule owned "Every container has an owner" {
      severity warning
      require owner on element(kind:container)
    }
  }
}
`;
