#!/usr/bin/env node
/**
 * Generates `assets/plantuml/Arch_Sprites.puml`.
 *
 * PlantUML sprites are monochrome bitmaps, not vectors, so our SVG icon packs
 * cannot simply be copied across — an SVG would have to be rasterised, which
 * would mean a rendering dependency this project does not have. Instead the
 * structural glyphs are authored here as ASCII art and encoded to PlantUML's
 * hex sprite format.
 *
 * ASCII art rather than hex literals on purpose: a 16x16 grid of `#` and `.`
 * can be read, reviewed and corrected by a human, whereas 16 lines of hex
 * cannot. The encoding is mechanical and deterministic.
 *
 * Technology logos are a separate matter: PlantUML already ships large sprite
 * libraries (tupadr3 devicons, font-awesome) that users can `!include`, and
 * our macros accept a $sprite argument for exactly that. We do not ship
 * bitmap copies of someone else's brand marks.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 16x16 glyphs. `#` is opaque, `.` is transparent, `+` is a half tone used for
 * anti-aliasing curves so shapes do not look jagged at small sizes.
 */
const GLYPHS = {
  person: [
    '................',
    '.....++####+....',
    '....##########..',
    '...####....####.',
    '...###......###.',
    '...###......###.',
    '...####....####.',
    '....##########..',
    '.....++####+....',
    '................',
    '..++##########+.',
    '.###############',
    '###############+',
    '###############.',
    '##############..',
    '................',
  ],
  system: [
    '................',
    '.++##########++.',
    '.##############.',
    '.##..........##.',
    '.##..######..##.',
    '.##..######..##.',
    '.##..######..##.',
    '.##..........##.',
    '.##..######..##.',
    '.##..######..##.',
    '.##..######..##.',
    '.##..........##.',
    '.##############.',
    '.++##########++.',
    '................',
    '................',
  ],
  container: [
    '................',
    '.......##.......',
    '....########....',
    '..############..',
    '.##############.',
    '.###.######.###.',
    '.###..####..###.',
    '.###...##...###.',
    '.###...##...###.',
    '.###...##...###.',
    '.###...##...###.',
    '.##############.',
    '..############..',
    '....########....',
    '.......##.......',
    '................',
  ],
  component: [
    '................',
    '................',
    '...###########..',
    '...###########..',
    '.####.......###.',
    '.####.......###.',
    '...###########..',
    '...###########..',
    '.####.......###.',
    '.####.......###.',
    '...###########..',
    '...###########..',
    '................',
    '................',
    '................',
    '................',
  ],
  database: [
    '................',
    '...++######++...',
    '..############..',
    '.####......####.',
    '.##############.',
    '..############..',
    '...++######++...',
    '.##############.',
    '.##############.',
    '..############..',
    '...++######++...',
    '.##############.',
    '.####......####.',
    '..############..',
    '...++######++...',
    '................',
  ],
  cache: [
    '................',
    '.........###....',
    '........####....',
    '.......####.....',
    '......####......',
    '.....######+....',
    '....########....',
    '...####...###...',
    '..####..........',
    '.####...........',
    '.###............',
    '................',
    '..############..',
    '..############..',
    '................',
    '................',
  ],
  queue: [
    '................',
    '................',
    '.##############.',
    '.##############.',
    '.##..##..##..##.',
    '.##..##..##..##.',
    '.##..##..##..##.',
    '.##..##..##..##.',
    '.##..##..##..##.',
    '.##..##..##..##.',
    '.##############.',
    '.##############.',
    '................',
    '.....######.....',
    '................',
    '................',
  ],
  topic: [
    '................',
    '.....######.....',
    '...##########...',
    '..####....####..',
    '.###........###.',
    '.##....##....##.',
    '.##...####...##.',
    '.##...####...##.',
    '.##....##....##.',
    '.###........###.',
    '..####....####..',
    '...##########...',
    '.....######.....',
    '................',
    '................',
    '................',
  ],
  api: [
    '................',
    '................',
    '.##############.',
    '.##############.',
    '.##..........##.',
    '.##..######..##.',
    '.##..######..##.',
    '.##..........##.',
    '.##############.',
    '.##############.',
    '................',
    '....##....##....',
    '....##....##....',
    '................',
    '................',
    '................',
  ],
  service: [
    '................',
    '......####......',
    '....########....',
    '...###....###...',
    '..###......###..',
    '.###..####..###.',
    '.###.######.###.',
    '.###.######.###.',
    '.###..####..###.',
    '..###......###..',
    '...###....###...',
    '....########....',
    '......####......',
    '................',
    '................',
    '................',
  ],
  browser: [
    '................',
    '.##############.',
    '.##############.',
    '.##..##..##..##.',
    '.##############.',
    '.##..........##.',
    '.##..........##.',
    '.##..........##.',
    '.##..........##.',
    '.##..........##.',
    '.##..........##.',
    '.##############.',
    '.##############.',
    '................',
    '................',
    '................',
  ],
  mobile: [
    '................',
    '....########....',
    '....########....',
    '....##....##....',
    '....##....##....',
    '....##....##....',
    '....##....##....',
    '....##....##....',
    '....##....##....',
    '....##....##....',
    '....##....##....',
    '....##.##.##....',
    '....########....',
    '....########....',
    '................',
    '................',
  ],
  function: [
    '................',
    '.........#####..',
    '........###.....',
    '.......###......',
    '......###.......',
    '..#########.....',
    '.....###........',
    '....###.........',
    '...###..........',
    '..###...........',
    '.#####..........',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  node: [
    '................',
    '.##############.',
    '.##############.',
    '.##..######..##.',
    '.##############.',
    '................',
    '.##############.',
    '.##############.',
    '.##..######..##.',
    '.##############.',
    '................',
    '.##############.',
    '.##############.',
    '.##..######..##.',
    '.##############.',
    '................',
  ],
  external: [
    '................',
    '.++##########++.',
    '.##############.',
    '.##..........##.',
    '.##..........##.',
    '.##....##....##.',
    '.##...####...##.',
    '.##..##..##..##.',
    '.##..##..##..##.',
    '.##..######..##.',
    '.##..........##.',
    '.##############.',
    '.++##########++.',
    '................',
    '................',
    '................',
  ],
};

/** `.` -> 0, `+` -> 8, `#` -> F. One hex digit per pixel, 16 per row. */
function encode(rows) {
  const levels = { '.': '0', '+': '8', '#': 'F' };
  return rows.map((row) => {
    if (row.length !== 16) {
      throw new Error(`glyph row must be 16 characters, got ${row.length}: "${row}"`);
    }
    return [...row]
      .map((character) => {
        const level = levels[character];
        if (level === undefined) throw new Error(`unknown pixel "${character}"`);
        return level;
      })
      .join('');
  });
}

const header = `' Archforge sprites — GENERATED by tools/build-plantuml.mjs, do not edit.
'
' Structural glyphs as PlantUML sprites. Use them with the $sprite argument:
'
'   Container(api, "Payment API", "Java / Spring Boot", "Handles payments", $sprite="arch_api")
'
' For technology logos, include one of PlantUML's own sprite libraries and pass
' the sprite name the same way, e.g.:
'
'   !include <tupadr3/devicons2/java>
'   Container(api, "Payment API", "Java", "", $sprite="java")
'
' Licence: CC0-1.0. These glyphs were drawn for this project.
`;

const sprites = Object.entries(GLYPHS)
  .sort(([left], [right]) => (left < right ? -1 : 1))
  .map(([name, rows]) => {
    const encoded = encode(rows);
    return `sprite $arch_${name} [16x16/16] {\n${encoded.join('\n')}\n}`;
  })
  .join('\n\n');

const target = join(root, 'assets', 'plantuml', 'src', 'Arch_Sprites.puml');
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${header}\n${sprites}\n`);

process.stdout.write(
  `[32m✓[0m assets/plantuml/Arch_Sprites.puml — ${
    Object.keys(GLYPHS).length
  } sprites\n`,
);


// ---------------------------------------------------------------------------
// Flatten the modular sources into self-contained distributables.
// ---------------------------------------------------------------------------
//
// Each published file inlines everything it needs, so a consumer writes one
// `!include <url>` and nothing else. That removes the whole class of problem a
// chained library has:
//
//   - PlantUML does not resolve a relative `!include` against a parent fetched
//     over http, so a chain breaks the moment the entry point is a URL
//   - working around that with absolute URLs bakes one repository and branch
//     into the files, so a fork or a tag silently loads someone else's copy
//   - a chain is also 3-4 HTTP round trips per diagram instead of one
//
// The modular sources under src/ stay the thing a human edits.

import { readFile as readSource } from 'node:fs/promises';

const SRC = join(root, 'assets', 'plantuml', 'src');
const OUT = join(root, 'assets', 'plantuml');

/** Recursively inlines local `!include`s, once each, stripping the scaffolding. */
async function flatten(entry, seen = new Set()) {
  if (seen.has(entry)) return '';
  seen.add(entry);

  const text = await readSource(join(SRC, entry), 'utf8');
  const out = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    // Include-once guards are meaningless once flattened.
    if (/^!if\s+%variable_exists\("ARCH_\w+_INCLUDED"\)/.test(trimmed)) {
      while (i < lines.length && !/^!endif/.test(lines[i].trim())) i += 1;
      continue;
    }
    if (/^!\$ARCH_\w+_INCLUDED\s*=/.test(trimmed)) continue;

    // The dual-mode include block: inline the target instead.
    if (/^!if\s+%variable_exists\("RELATIVE_INCLUDE"\)/.test(trimmed)) {
      const block = [];
      while (i < lines.length && !/^!endif/.test(lines[i].trim())) {
        block.push(lines[i]);
        i += 1;
      }
      const target = block
        .map((l) => /!include\s+\.\/(Arch_\w+\.puml)/.exec(l.trim()))
        .find(Boolean);
      if (target) out.push(await flatten(target[1], seen));
      continue;
    }

    // A plain local include.
    const plain = /^!include\s+(?:\.\/)?(Arch_\w+\.puml)$/.exec(trimmed);
    if (plain) {
      out.push(await flatten(plain[1], seen));
      continue;
    }

    // The include-base variable and its explanatory comment are now dead.
    if (/^!\$ARCH_INCLUDE_BASE\s*\?=/.test(trimmed)) continue;

    out.push(line);
  }
  return out.join('\n');
}

const ENTRIES = [
  ['Arch_Context.puml', 'people and systems'],
  ['Arch_Container.puml', 'containers'],
  ['Arch_Component.puml', 'components'],
  ['Arch_Deployment.puml', 'deployment and infrastructure nodes'],
  ['Arch_Dynamic.puml', 'numbered interactions'],
];

for (const [entry, scope] of ENTRIES) {
  const body = await flatten(entry);
  const banner = [
    `' Archforge for PlantUML — ${scope}`,
    "'",
    "' GENERATED and SELF-CONTAINED. Do not edit; edit assets/plantuml/src/ and",
    "' run `node tools/build-plantuml.mjs`.",
    "'",
    "' Include it and nothing else — locally or straight from a URL:",
    "'",
    `'   !include ${entry}`,
    `'   !include https://raw.githubusercontent.com/<owner>/<repo>/main/assets/plantuml/${entry}`,
    "'",
    "' No other files are fetched, no flags are needed, and a fork or a tag",
    "' works without editing anything.",
    "'",
    "' Licence: Apache-2.0.",
    '',
  ].join('\n');

  // Collapse the runs of blank lines that inlining leaves behind.
  const tidy = body.replace(/\n{3,}/g, '\n\n').replace(/^\s*\n/, '');
  await writeFile(join(OUT, entry), `${banner}${tidy}\n`);
  process.stdout.write(
    `\x1b[32m✓\x1b[0m assets/plantuml/${entry} — self-contained, ${
      (`${banner}${tidy}`).split('\n').length
    } lines\n`,
  );
}
