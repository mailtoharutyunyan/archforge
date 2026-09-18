/**
 * Deterministic text measurement.
 *
 * Layout has to produce identical geometry in Node and in the browser, so it
 * cannot ask a canvas or a DOM node how wide a string is. Instead we
 * approximate advance widths from a small per-character table. It is not
 * pixel-exact against a real font, but it is consistent everywhere and
 * accurate enough to size boxes and wrap labels — and, crucially, the same
 * input always yields the same bytes.
 */

/** Advance width as a fraction of the font size, by character class. */
const NARROW = new Set([...'iljItf.,;:\'"!|()[]{}`-']);
const WIDE = new Set([...'mMWQ@%&']);

function advanceRatio(char: string): number {
  if (char === ' ') return 0.28;
  if (NARROW.has(char)) return 0.31;
  if (WIDE.has(char)) return 0.9;
  if (char >= 'A' && char <= 'Z') return 0.67;
  if (char >= '0' && char <= '9') return 0.56;
  if (char >= 'a' && char <= 'z') return 0.54;
  // CJK and other wide scripts occupy roughly a full em.
  if (char.codePointAt(0)! > 0x2e80) return 1;
  return 0.56;
}

export function measureText(text: string, fontSize: number): number {
  let total = 0;
  for (const char of text) total += advanceRatio(char);
  return Math.round(total * fontSize * 100) / 100;
}

/**
 * Greedy word wrap to a pixel width. Words longer than the line are split at
 * the character level rather than allowed to overflow the box.
 */
export function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized === '') return [];

  const lines: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.length > 0) {
      lines.push(current);
      current = '';
    }
  };

  for (const word of normalized.split(' ')) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (measureText(candidate, fontSize) <= maxWidth) {
      current = candidate;
      continue;
    }
    flush();
    if (measureText(word, fontSize) <= maxWidth) {
      current = word;
      continue;
    }
    // Hard-split an over-long token.
    let piece = '';
    for (const char of word) {
      if (measureText(piece + char, fontSize) > maxWidth && piece.length > 0) {
        lines.push(piece);
        piece = char;
      } else {
        piece += char;
      }
    }
    current = piece;
  }
  flush();
  return lines;
}

/** Truncates with an ellipsis so long labels cannot blow out a layout. */
export function truncateText(text: string, fontSize: number, maxWidth: number): string {
  if (measureText(text, fontSize) <= maxWidth) return text;
  let out = '';
  for (const char of text) {
    if (measureText(`${out}${char}…`, fontSize) > maxWidth) break;
    out += char;
  }
  return `${out}…`;
}

/** Escapes text for inclusion in SVG or XML character data. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
