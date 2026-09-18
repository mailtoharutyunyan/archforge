#!/usr/bin/env node
/**
 * The `arch` command line.
 *
 * This is a thin adapter over the engine: it reads files, calls core, and
 * formats output. No architecture logic lives here, which is what keeps the
 * CLI, the web editor and any future CI action behaving identically.
 *
 * Exit codes are part of the contract, because the point of the tool is to
 * gate a pull request:
 *   0  success, nothing to report
 *   1  findings (rule violations, drift, or a non-empty diff with --exit-code)
 *   2  bad usage or unreadable input
 *   3  the model itself does not compile
 */

import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import {
  ArchModel,
  canonicalJson,
  check,
  compileFiles,
  derive,
  deriveAll,
  diff,
  documentWorkspace,
  formatDiff,
  formatLoc,
  hasErrors,
  layout,
  parseLayout,
  pruneLayout,
  RECOMMENDED_RULES,
  renderSvg,
  serializeLayout,
  emitWorkspace,
  sortDiagnostics,
  synthesizeWorkspace,
  toMermaid,
  toPlantUml,
  undeclaredSteps,
  type Diagnostic,
  type DerivedView,
  type SourceFile,
  type Violation,
} from '../../core/src/index.ts';

const VERSION = '0.1.0';

// ------------------------------------------------------------------ arg parsing

interface Args {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

function parseArgs(argv: readonly string[]): Args {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');
      if (equals >= 0) {
        flags[body.slice(0, equals)] = body.slice(equals + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      const short = token.slice(1);
      const next = argv[i + 1];
      const expand: Record<string, string> = { o: 'out', v: 'view', f: 'format', r: 'repo' };
      const name = expand[short] ?? short;
      if (next !== undefined && !next.startsWith('-')) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }
    positionals.push(token);
  }

  return { command: positionals[0] ?? 'help', positionals: positionals.slice(1), flags };
}

function flagString(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

function flagBool(args: Args, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true';
}

// ------------------------------------------------------------------- terminal

const useColour =
  process.env['NO_COLOR'] === undefined &&
  process.env['TERM'] !== 'dumb' &&
  Boolean(process.stdout.isTTY);

const paint = (code: string, text: string): string =>
  useColour ? `[${code}m${text}[0m` : text;
const bold = (text: string): string => paint('1', text);
const dim = (text: string): string => paint('2', text);
const red = (text: string): string => paint('31', text);
const green = (text: string): string => paint('32', text);
const yellow = (text: string): string => paint('33', text);
const blue = (text: string): string => paint('36', text);

const ICON_OK = useColour ? '✓' : 'OK';
const ICON_WARN = useColour ? '⚠' : '!';
const ICON_FAIL = useColour ? '✗' : 'X';

function out(text = ''): void {
  process.stdout.write(`${text}\n`);
}

function fail(message: string, code = 2): never {
  process.stderr.write(`${red('error')} ${message}\n`);
  process.exit(code);
}

// --------------------------------------------------------------- source loading

const SOURCE_EXTENSIONS = ['.arch', '.af'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'dist', 'out']);

/** Expands paths into DSL source files; directories are searched recursively. */
async function loadSources(paths: readonly string[]): Promise<SourceFile[]> {
  const candidates = paths.length > 0 ? paths : await defaultSourcePaths();
  if (candidates.length === 0) {
    fail(
      'no architecture sources found.\n' +
        `  Pass a file or directory, or run ${bold('arch init')} to create one.`,
    );
  }

  const files: string[] = [];
  for (const path of candidates) {
    const absolute = resolve(path);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      fail(`cannot read ${path}`);
    }
    if (info.isDirectory()) {
      files.push(...(await findSources(absolute)));
    } else {
      files.push(absolute);
    }
  }

  if (files.length === 0) fail(`no ${SOURCE_EXTENSIONS.join(' or ')} files found`);

  // Sorted so that compilation order — and therefore diagnostics order — does
  // not depend on the order the filesystem happened to return entries in.
  const sources: SourceFile[] = [];
  for (const file of [...new Set(files)].sort()) {
    sources.push({
      file: relative(process.cwd(), file).split(sep).join('/'),
      text: await readFile(file, 'utf8'),
    });
  }
  return sources;
}

async function defaultSourcePaths(): Promise<string[]> {
  for (const candidate of ['.archforge', 'architecture', '.']) {
    try {
      const found = await findSources(resolve(candidate));
      if (found.length > 0) return [candidate];
    } catch {
      // Keep looking.
    }
  }
  return [];
}

async function findSources(dir: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.') && entry.name !== '.archforge') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...(await findSources(full)));
      continue;
    }
    if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) found.push(full);
  }
  return found;
}

/** Compiles, reports diagnostics, and exits 3 if the model is not usable. */
async function loadModel(paths: readonly string[]): Promise<ArchModel> {
  const sources = await loadSources(paths);
  const result = compileFiles(sources);
  reportDiagnostics(result.diagnostics);
  if (hasErrors(result.diagnostics)) {
    process.exit(3);
  }
  return new ArchModel(result.workspace);
}

function reportDiagnostics(diagnostics: readonly Diagnostic[]): void {
  for (const diagnostic of sortDiagnostics(diagnostics)) {
    const label =
      diagnostic.severity === 'error'
        ? red('error')
        : diagnostic.severity === 'warning'
          ? yellow('warning')
          : blue('info');
    const location = diagnostic.loc ? `${dim(formatLoc(diagnostic.loc))} ` : '';
    process.stderr.write(`${location}${label} ${diagnostic.message} ${dim(diagnostic.code)}\n`);
    if (diagnostic.hint) process.stderr.write(`  ${dim(diagnostic.hint)}\n`);
  }
}

// ----------------------------------------------------------------- commands

async function commandCheck(args: Args): Promise<void> {
  const model = await loadModel(args.positionals);
  const extra = flagBool(args, 'recommended') ? RECOMMENDED_RULES : [];
  const result = check(model, extra);

  // Dynamic views referencing dependencies that do not exist are almost always
  // a typo, so surface them alongside rule violations.
  const stepWarnings: string[] = [];
  for (const view of model.views) {
    for (const missing of undeclaredSteps(model, view)) {
      stepWarnings.push(`view \`${view.id}\`: step \`${missing}\` is not a declared relationship`);
    }
  }

  if (flagBool(args, 'json')) {
    out(
      canonicalJson({
        ok: result.summary.errors === 0,
        summary: result.summary,
        violations: result.violations,
        ruleErrors: result.ruleErrors,
        undeclaredSteps: stepWarnings,
      }).trimEnd(),
    );
    process.exit(result.summary.errors > 0 ? 1 : 0);
  }

  out(bold('ARCHITECTURE CHECK'));
  out(
    dim(
      `${model.workspace.name} · ${result.summary.elements} elements · ` +
        `${result.summary.relations} relationships · ${result.summary.rulesEvaluated} rules`,
    ),
  );
  out();

  for (const error of result.ruleErrors) {
    out(`${yellow(ICON_WARN)} ${error}`);
  }

  if (result.violations.length === 0 && stepWarnings.length === 0) {
    if (result.summary.rulesEvaluated === 0) {
      out(`${yellow(ICON_WARN)} No rules defined — nothing was actually checked.`);
      out(dim('  Add a `rules { ... }` block, or run with --recommended.'));
      process.exit(0);
    }
    out(`${green(ICON_OK)} All ${result.summary.rulesEvaluated} rules pass.`);
    process.exit(0);
  }

  let lastRule = '';
  for (const violation of result.violations) {
    if (violation.ruleId !== lastRule) {
      out(bold(`${violation.ruleTitle ?? violation.ruleId} ${dim(`(${violation.ruleId})`)}`));
      lastRule = violation.ruleId;
    }
    out(`  ${severityIcon(violation)} ${violation.message}`);
    if (violation.loc) out(`    ${dim(formatLoc(violation.loc))}`);
    if (violation.detail) out(`    ${dim(violation.detail)}`);
  }
  for (const warning of stepWarnings) {
    out(`  ${yellow(ICON_WARN)} ${warning}`);
  }

  out();
  out(
    `${result.summary.errors} error(s), ${result.summary.warnings} warning(s), ` +
      `${result.summary.infos} info.`,
  );
  process.exit(result.summary.errors > 0 ? 1 : 0);
}

function severityIcon(violation: Violation): string {
  if (violation.severity === 'error') return red(ICON_FAIL);
  if (violation.severity === 'warning') return yellow(ICON_WARN);
  return blue('i');
}

async function commandModel(args: Args): Promise<void> {
  const model = await loadModel(args.positionals);
  if (flagBool(args, 'json') || flagString(args, 'format') === 'json') {
    out(canonicalJson(model.workspace).trimEnd());
    return;
  }

  out(bold(model.workspace.name));
  if (model.workspace.description) out(dim(model.workspace.description));
  out();

  const print = (id: string, depth: number): void => {
    const element = model.requireElement(id);
    const indent = '  '.repeat(depth);
    const meta = [element.subtype ?? element.kind, element.technology]
      .filter((value): value is string => Boolean(value))
      .join(', ');
    out(`${indent}${element.name} ${dim(`[${meta}]`)} ${dim(element.id)}`);
    for (const child of model.children(id)) print(child.id, depth + 1);
  };
  for (const root of model.roots()) print(root.id, 0);

  out();
  out(bold('Relationships'));
  for (const relation of model.relations) {
    const source = model.element(relation.sourceId)?.name ?? relation.sourceId;
    const dest = model.element(relation.destId)?.name ?? relation.destId;
    const arrow = relation.direction === 'bi' ? '<->' : '->';
    const label = [relation.description, relation.technology && `[${relation.technology}]`]
      .filter(Boolean)
      .join(' ');
    out(`  ${source} ${arrow} ${dest} ${dim(label)}`);
  }

  out();
  out(bold('Views'));
  for (const view of model.views) {
    out(`  ${view.id} ${dim(`${view.kind}${view.scopeId ? ` of ${view.scopeId}` : ''}`)}`);
  }
}

async function commandViews(args: Args): Promise<void> {
  const model = await loadModel(args.positionals);
  if (model.views.length === 0) {
    out(`${yellow(ICON_WARN)} No views defined.`);
    return;
  }
  for (const view of deriveAll(model)) {
    out(
      `${bold(view.id)} ${dim(`${view.kind}`)} — ${view.nodes.length} elements, ` +
        `${view.edges.length} relationships`,
    );
  }
}

async function commandRender(args: Args): Promise<void> {
  const model = await loadModel(args.positionals);
  const format = flagString(args, 'format') ?? 'svg';
  const requested = flagString(args, 'view');
  const outPath = flagString(args, 'out');
  const all = flagBool(args, 'all') || requested === undefined;

  const definitions = all
    ? model.views
    : model.views.filter((view) => view.id === requested);

  if (definitions.length === 0) {
    fail(
      requested
        ? `unknown view \`${requested}\`. Available: ${model.views.map((v) => v.id).join(', ') || '(none)'}`
        : 'no views defined',
    );
  }

  if (!all && outPath === undefined && definitions.length === 1) {
    // Single view with no destination: write to stdout so it can be piped.
    const view = derive(model, definitions[0] as (typeof definitions)[number]);
    out(await renderOne(model, view, format, args).trimEnd());
    return;
  }

  const directory = outPath ?? 'out/diagrams';
  await mkdir(directory, { recursive: true });

  for (const definition of definitions) {
    const view = derive(model, definition);
    const content = renderOne(model, view, format, args);
    const file = join(directory, `${view.id}.${extensionFor(format)}`);
    await writeFile(file, content, 'utf8');
    out(`${green(ICON_OK)} ${file} ${dim(`${view.nodes.length} elements`)}`);
  }
}

function renderOne(
  model: ArchModel,
  view: DerivedView,
  format: string,
  args: Args,
): string {
  const direction = flagString(args, 'direction') === 'LR' ? 'LR' : 'TB';
  switch (format) {
    case 'svg': {
      const theme = flagString(args, 'theme');
      const computed = layout(view, { direction });
      return renderSvg(view, computed, {
        theme: theme === 'light' || theme === 'dark' ? theme : 'auto',
        showLegend: flagBool(args, 'legend'),
        interactive: flagBool(args, 'interactive'),
        workspaceName: model.workspace.name,
      });
    }
    case 'puml':
    case 'plantuml':
      return toPlantUml(model, view, { direction });
    case 'mmd':
    case 'mermaid':
      return toMermaid(view, { direction });
    case 'json':
      return canonicalJson({ view, layout: layout(view, { direction }) });
    default:
      return fail(`unknown format \`${format}\`. Use svg, puml, mermaid or json.`);
  }
}

function extensionFor(format: string): string {
  switch (format) {
    case 'puml':
    case 'plantuml':
      return 'puml';
    case 'mmd':
    case 'mermaid':
      return 'mmd';
    case 'json':
      return 'json';
    default:
      return 'svg';
  }
}

async function commandDiff(args: Args): Promise<void> {
  const [beforePath, afterPath] = args.positionals;
  if (!beforePath || !afterPath) {
    fail('usage: arch diff <before> <after>');
  }

  const before = await loadModel([beforePath]);
  const after = await loadModel([afterPath]);
  const result = diff(before, after);

  if (flagBool(args, 'json')) {
    out(canonicalJson(result).trimEnd());
  } else {
    process.stdout.write(formatDiff(result, { colour: useColour }));
  }
  if (flagBool(args, 'exit-code') && result.summary.total > 0) process.exit(1);
}

async function commandImpact(args: Args): Promise<void> {
  const target = args.positionals[args.positionals.length - 1];
  const paths = args.positionals.slice(0, -1);
  if (!target) fail('usage: arch impact [sources...] <elementId>');

  const model = await loadModel(paths);
  const element = model.element(target) ?? model.elements.find((e) => e.name === target);
  if (!element) {
    fail(`unknown element \`${target}\``);
  }

  const dependents = model.dependents(element.id);
  const direct = model.dependents(element.id, { transitive: false });
  const dependencies = model.dependencies(element.id);

  if (flagBool(args, 'json')) {
    out(
      canonicalJson({
        element: element.id,
        directDependents: direct.map((e) => e.id),
        transitiveDependents: dependents.map((e) => e.id),
        dependencies: dependencies.map((e) => e.id),
        affectedSystems: [
          ...new Set(
            dependents.map((e) => model.ancestorOfKind(e.id, 'system')?.id ?? e.id),
          ),
        ].sort(),
      }).trimEnd(),
    );
    return;
  }

  out(bold(`IMPACT · ${element.name}`));
  out(dim(element.id));
  out();
  out(`${bold('Direct dependents')} (${direct.length})`);
  for (const dependent of direct) out(`  ← ${dependent.name} ${dim(dependent.id)}`);
  const indirect = dependents.filter((d) => !direct.some((x) => x.id === d.id));
  if (indirect.length > 0) {
    out();
    out(`${bold('Transitive dependents')} (${indirect.length})`);
    for (const dependent of indirect) out(`  ⇠ ${dependent.name} ${dim(dependent.id)}`);
  }
  out();
  out(`${bold('Depends on')} (${dependencies.length})`);
  for (const dependency of dependencies) out(`  → ${dependency.name} ${dim(dependency.id)}`);

  const systems = [
    ...new Set(dependents.map((e) => model.ancestorOfKind(e.id, 'system')?.name ?? e.name)),
  ].sort();
  if (systems.length > 0) {
    out();
    out(`${bold('Affected systems')}: ${systems.join(', ')}`);
  }
}

async function commandDrift(args: Args): Promise<void> {
  const repo = flagString(args, 'repo') ?? '.';
  const model = await loadModel(args.positionals);

  // Imported lazily so the rest of the CLI works even where the scanner is
  // unavailable, and so browser bundles of core never pull in `node:fs`.
  const { scanRepo } = await import('../../core/src/scan/node.ts');
  const { detectDrift } = await import('../../core/src/drift/drift.ts');

  const scan = await scanRepo({ root: resolve(repo) });
  const report = detectDrift({ model, scan });

  if (flagBool(args, 'json')) {
    out(canonicalJson(report).trimEnd());
    process.exit(report.findings.some((f) => f.severity === 'error') ? 1 : 0);
  }

  out(bold('ARCHITECTURE DRIFT'));
  out(
    dim(
      `${report.summary.scannedFiles} files scanned · ` +
        `${report.summary.declaredRelations} declared · ` +
        `${report.summary.inferredRelations} detected`,
    ),
  );
  out();

  if (report.findings.length === 0) {
    out(`${green(ICON_OK)} No drift detected.`);
    if (report.unboundElements.length > 0) {
      out(
        dim(
          `  Note: ${report.unboundElements.length} element(s) have no \`source\` binding, ` +
            'so they were not checked.',
        ),
      );
    }
    process.exit(0);
  }

  for (const finding of report.findings) {
    const icon =
      finding.severity === 'error' ? red(ICON_FAIL) : finding.severity === 'warning' ? yellow(ICON_WARN) : blue('i');
    out(`${icon} ${finding.message}`);
    if (finding.detector) {
      out(`    ${dim(`detector: ${finding.detector} · confidence: ${finding.confidence ?? 'n/a'}`)}`);
    }
    for (const evidence of finding.evidence.slice(0, 3)) {
      out(`    ${dim(`${evidence.file}:${evidence.line}`)}  ${evidence.snippet.trim()}`);
    }
  }

  out();
  const errors = report.findings.filter((f) => f.severity === 'error').length;
  out(`${report.findings.length} finding(s), ${errors} error(s).`);
  process.exit(errors > 0 ? 1 : 0);
}

/**
 * Reverse-engineers a repository into a model you then own.
 *
 * The output is a `.arch` file with every element marked inferred and carrying
 * its evidence, plus `source` bindings already filled in — which is what lets
 * the next step be `arch drift` rather than another full re-scan.
 */
async function commandAnalyze(args: Args): Promise<void> {
  const repo = args.positionals[0] ?? flagString(args, 'repo') ?? '.';
  const { scanRepo } = await import('../../core/src/scan/node.ts');

  const absolute = resolve(repo);
  // Progress goes to stderr: stdout carries the generated model, and
  // `arch analyze > architecture.arch` must produce a file that compiles.
  process.stderr.write(`${dim(`Scanning ${relative(process.cwd(), absolute) || '.'} …`)}\n`);
  const scan = await scanRepo({ root: absolute });

  if (flagBool(args, 'json')) {
    out(canonicalJson(scan).trimEnd());
    return;
  }

  const name = flagString(args, 'name') ?? (absolute.split(sep).pop() ?? 'Scanned system');
  const workspace = synthesizeWorkspace(scan, { name });
  const source = emitWorkspace(new ArchModel(workspace), { annotateProvenance: true });

  const outPath = flagString(args, 'out');
  if (outPath) {
    await mkdir(dirname(resolve(outPath)), { recursive: true });
    await writeFile(resolve(outPath), source, 'utf8');
  } else {
    process.stdout.write(source);
  }

  process.stderr.write(
    `\n${dim('—')} ${scan.files.length} files · ${scan.languages.join(', ') || 'no known stacks'}\n` +
      `${dim('—')} ${scan.components.length} components, ${scan.externals.length} dependencies, ` +
      `${scan.relations.length} relationships\n` +
      `${dim('—')} scanners: ${scan.scannersRun.join(', ') || 'none matched'}\n` +
      (outPath ? `${green(ICON_OK)} ${outPath}\n` : '') +
      `\n${yellow(ICON_WARN)} Everything is marked ${bold('inferred')}. Review it, fix what is wrong,\n` +
      `  then run ${bold('arch drift')} to keep it honest as the code changes.\n`,
  );
}

async function commandDocs(args: Args): Promise<void> {
  const model = await loadModel(args.positionals);
  const views = deriveAll(model);
  const directory = flagString(args, 'out') ?? 'out/docs';
  await mkdir(join(directory, 'diagrams'), { recursive: true });

  for (const view of views) {
    const computed = layout(view, {});
    await writeFile(
      join(directory, 'diagrams', `${view.id}.svg`),
      renderSvg(view, computed, { workspaceName: model.workspace.name }),
      'utf8',
    );
  }
  const markdown = documentWorkspace(model, views, { diagramDir: 'diagrams' });
  const file = join(directory, 'ARCHITECTURE.md');
  await writeFile(file, markdown, 'utf8');
  out(`${green(ICON_OK)} ${file} ${dim(`${views.length} views`)}`);
}

async function commandLayout(args: Args): Promise<void> {
  const model = await loadModel(args.positionals);
  const directory = flagString(args, 'dir') ?? '.archforge/layouts';
  let pruned = 0;

  for (const view of deriveAll(model)) {
    const file = join(directory, `${view.id}.json`);
    let existing = '';
    try {
      existing = await readFile(file, 'utf8');
    } catch {
      continue; // No manual layout for this view; nothing to prune.
    }
    const result = pruneLayout(parseLayout(existing, view.id), view);
    if (result.removed.length === 0) continue;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, serializeLayout(result.layout), 'utf8');
    pruned += result.removed.length;
    out(`${green(ICON_OK)} ${file} ${dim(`pruned ${result.removed.join(', ')}`)}`);
  }
  if (pruned === 0) out(`${green(ICON_OK)} All manual layouts are current.`);
}

async function commandInit(args: Args): Promise<void> {
  const directory = args.positionals[0] ?? '.archforge';
  await mkdir(directory, { recursive: true });

  const architecture = `workspace "My Platform" {

  description "Replace this with what the platform is for."

  person customer "Customer" {
    description "Uses the platform."
  }

  system platform "My Platform" {
    description "The system being described."
    owner "platform-team"
    tag domain-core

    container api "API" {
      technology "Java 21 / Spring Boot"
      description "Handles inbound requests."
      // Binding to real code is what makes \`arch drift\` possible.
      source "services/api"
      tag internal
    }

    database db "Primary database" {
      technology "PostgreSQL 16"
    }
  }

  customer -> platform.api "Uses" {
    technology "HTTPS/JSON"
  }

  platform.api -> platform.db "Reads and writes" {
    technology "JDBC"
  }

  views {
    context landscape "System landscape" of platform
    container platform-containers "Containers" of platform
  }

  rules {
    rule no-cycles "Architecture must be acyclic" {
      severity error
      forbid cycles
    }

    rule containers-owned "Every container has an owner" {
      severity warning
      require owner on element(kind:container)
    }
  }
}
`;

  const file = join(directory, 'architecture.arch');
  await writeFile(file, architecture, 'utf8');
  await mkdir(join(directory, 'layouts'), { recursive: true });

  out(`${green(ICON_OK)} ${file}`);
  out();
  out('Next:');
  out(`  ${bold('arch check')}                  validate the model`);
  out(`  ${bold('arch render --all')}           write SVG diagrams to out/diagrams`);
  out(`  ${bold('arch docs')}                   generate ARCHITECTURE.md`);
}

async function commandIcons(args: Args): Promise<void> {
  const { ICON_PACKS, listIcons, resolveIcon } = await import('../../core/src/render/icons.ts');
  const query = flagString(args, 'resolve');

  if (query) {
    const icon = resolveIcon({ kind: 'container', technology: query });
    out(icon ? `${query} → ${icon.id} ${dim(`(${icon.pack}, ${icon.license})`)}` : `${query} → no match`);
    return;
  }

  out(bold('ICON PACKS'));
  for (const pack of ICON_PACKS) {
    out(`  ${pack.name.padEnd(14)} ${String(pack.count).padStart(4)} icons  ${dim(pack.license)}`);
  }
  out();
  out(dim(`${listIcons().length} icons available offline.`));
}

function commandHelp(): void {
  out(`${bold('arch')} ${dim(VERSION)} — architecture as code

${bold('USAGE')}
  arch <command> [sources...] [options]

  Sources are .arch files or directories. When omitted, arch looks in
  .archforge/, architecture/, then the current directory.

${bold('COMMANDS')}
  init [dir]              scaffold a new architecture workspace
  check [sources]         compile the model and evaluate architecture rules
  model [sources]         print the resolved model as a tree, or --json
  views [sources]         list derived views
  render [sources]        render diagrams (--format svg|puml|mermaid|json)
  analyze [repo]          reverse-engineer a repository into a .arch model
  diff <before> <after>   structural diff between two models
  impact [sources] <id>   what depends on an element, directly and transitively
  drift [sources] --repo  compare the model against real source code
  docs [sources]          generate ARCHITECTURE.md plus diagrams
  layout [sources]        prune stale manual positions
  icons                   list vendored icon packs

${bold('OPTIONS')}
  --json                  machine-readable output
  --view <id>             render a single view
  --all                   render every view
  --format <fmt>          svg (default), puml, mermaid, json
  --out <path>            output file or directory
  --direction TB|LR       layout direction
  --theme light|dark      force a palette instead of following the viewer
  --legend                include a legend
  --interactive           emit editor hooks in the SVG
  --recommended           add the recommended rule set to a check
  --repo <dir>            repository root for drift detection
  --exit-code             exit 1 when a diff is non-empty

${bold('EXIT CODES')}
  0 clean · 1 findings · 2 usage error · 3 model does not compile

${bold('EXAMPLES')}
  arch check --recommended
  arch render --view platform-containers --format svg -o out/containers.svg
  arch drift --repo . --json
  arch diff main.arch feature.arch --exit-code
`);
}

// ---------------------------------------------------------------------- entry

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'check':
    case 'validate':
      return commandCheck(args);
    case 'model':
      return commandModel(args);
    case 'views':
      return commandViews(args);
    case 'render':
      return commandRender(args);
    case 'analyze':
    case 'analyse':
      return commandAnalyze(args);
    case 'diff':
      return commandDiff(args);
    case 'impact':
      return commandImpact(args);
    case 'drift':
      return commandDrift(args);
    case 'docs':
      return commandDocs(args);
    case 'layout':
      return commandLayout(args);
    case 'init':
      return commandInit(args);
    case 'icons':
      return commandIcons(args);
    case 'version':
    case '--version':
      out(VERSION);
      return;
    case 'help':
    case '--help':
      commandHelp();
      return;
    default:
      process.stderr.write(`${red('error')} unknown command \`${args.command}\`\n\n`);
      commandHelp();
      process.exit(2);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${red('error')} ${message}\n`);
  if (process.env['ARCH_DEBUG'] && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(2);
});
