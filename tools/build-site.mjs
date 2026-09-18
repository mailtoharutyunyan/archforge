#!/usr/bin/env node
/**
 * Builds the static site into `site/`.
 *
 * The whole point of this script is that its output needs no server: TypeScript
 * is compiled to native ES modules the browser loads directly, the HTML and CSS
 * are copied verbatim, and the landing page's preview image is rendered by the
 * real engine rather than mocked up. Publishing is then "serve this folder",
 * which is exactly what GitHub Pages does.
 */

import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'site');

const step = (message) => process.stdout.write(`[2m›[0m ${message}\n`);
const ok = (message) => process.stdout.write(`[32m✓[0m ${message}\n`);
const fail = (message) => {
  process.stderr.write(`[31m✗[0m ${message}\n`);
  process.exit(1);
};

// ---------------------------------------------------------------- 1. clean

step('cleaning site/');
await rm(site, { recursive: true, force: true });
await mkdir(site, { recursive: true });

// ------------------------------------------------------------- 2. compile

step('compiling TypeScript to ES modules');
const tsc = join(root, 'node_modules', '.bin', 'tsc');
if (!existsSync(tsc)) {
  fail('TypeScript is not installed. Run `npm install` first.');
}
const compile = spawnSync(tsc, ['-p', 'tsconfig.web.json'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (compile.status !== 0) {
  process.stderr.write(`${compile.stdout ?? ''}${compile.stderr ?? ''}\n`);
  fail('TypeScript compilation failed.');
}
ok('compiled to site/js');

// ---------------------------------------------------------------- 3. copy

step('copying static assets');
const copies = [
  ['packages/web/index.html', 'index.html'],
  ['packages/web/landing.css', 'landing.css'],
  ['packages/web/styles.css', 'styles.css'],
  ['packages/web/app/index.html', 'app/index.html'],
  ['packages/web/split/index.html', 'split/index.html'],
  ['packages/web/split.css', 'split.css'],
  ['packages/web/favicon.svg', 'favicon.svg'],
];
for (const [from, to] of copies) {
  const target = join(site, to);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(root, from), target);
}

// The editor's "Example" button fetches these.
await mkdir(join(site, 'examples'), { recursive: true });
await cp(
  join(root, 'examples/payment-platform/architecture.arch'),
  join(site, 'examples/payment-platform.arch'),
);
await cp(
  join(root, 'examples/globex-commerce/architecture.arch'),
  join(site, 'examples/globex-commerce.arch'),
);

// The PlantUML macro library is published as part of the site, so it can be
// included straight from a URL the way C4-PlantUML is:
//   !include https://<user>.github.io/<repo>/plantuml/Arch_Container.puml
await cp(join(root, 'assets/plantuml'), join(site, 'plantuml'), { recursive: true });

// Tells GitHub Pages not to run Jekyll, which would drop paths starting with `_`.
await writeFile(join(site, '.nojekyll'), '');
ok('copied HTML, CSS and the example model');

// ------------------------------------------------- 4. render the preview

step('rendering the landing page preview with the real engine');
const core = join(site, 'js', 'core', 'src');
const { compileFiles } = await import(join(core, 'dsl', 'compile.js'));
const { ArchModel } = await import(join(core, 'model', 'model.js'));
const { derive } = await import(join(core, 'views', 'views.js'));
const { layout } = await import(join(core, 'layout', 'layered.js'));
const { renderSvg } = await import(join(core, 'render', 'svg.js'));

const exampleText = await readFile(
  join(root, 'examples/payment-platform/architecture.arch'),
  'utf8',
);
const compiled = compileFiles([{ file: 'architecture.arch', text: exampleText }]);
if (compiled.diagnostics.some((d) => d.severity === 'error')) {
  fail('the example model does not compile, so the preview cannot be rendered');
}

const model = new ArchModel(compiled.workspace);
const definition = model.views.find((view) => view.id === 'platform') ?? model.views[0];
if (!definition) fail('the example model defines no views');

// Left-to-right reads better in the hero's landscape-shaped frame; a tall
// top-to-bottom render shrinks to illegibility at that aspect ratio.
const view = derive(model, definition);
const computed = layout(view, { direction: 'LR' });

// One render per theme rather than `auto`. `auto` follows the operating
// system, which would put a white diagram on the page's dark theme whenever
// the two disagree; the page swaps these with CSS so the preview always
// matches what the visitor is actually looking at.
for (const theme of ['light', 'dark']) {
  const svg = renderSvg(view, computed, {
    theme,
    workspaceName: model.workspace.name,
    showLegend: true,
  });
  await writeFile(join(site, `preview-${theme}.svg`), svg);
}
ok(`preview-light.svg + preview-dark.svg — ${view.nodes.length} elements, ${view.edges.length} relationships`);

// ------------------------------------------------------------- 5. report

const { execSync } = await import('node:child_process');
let size = 'unknown';
try {
  size = execSync(`du -sh "${site}"`, { encoding: 'utf8' }).split('\t')[0]?.trim() ?? 'unknown';
} catch {
  // du is not essential.
}

process.stdout.write(
  `\n${'[1m'}Site built${'[0m'} → site/  (${size})\n` +
    `  landing   site/index.html\n` +
    `  editor    site/app/index.html\n\n` +
    `Preview locally:\n` +
    `  npx --yes http-server site -p 8080    ${'[2m'}# or any static server${'[0m'}\n` +
    `  python3 -m http.server 8080 -d site\n\n`,
);
