#!/usr/bin/env node
/**
 * Model Context Protocol server for Archforge.
 *
 * This is how an AI agent works on architecture: not by drawing, and not
 * through a CRUD API over the graph, but by *proposing text* and being shown
 * the consequences.
 *
 * The design rule is the one from the product principles: an agent may read
 * anything, but it may never silently mutate the model. `propose` compiles a
 * candidate source, validates it, diffs it against the current model and
 * returns that for review. `apply` is a separate call that writes to disk and
 * requires an explicit confirmation flag. A reviewer therefore always sees a
 * structural diff plus a rule verdict before anything lands, which is what
 * makes agent-authored architecture auditable rather than alarming.
 *
 * Transport is newline-delimited JSON-RPC 2.0 over stdio, implemented directly
 * so the server inherits the project's zero-dependency guarantee.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

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
  hasErrors,
  layout,
  parseSelector,
  RECOMMENDED_RULES,
  renderSvg,
  select,
  sortDiagnostics,
  toMermaid,
  toPlantUml,
  type Diagnostic,
} from '../../core/src/index.ts';
import { detectDrift } from '../../core/src/drift/drift.ts';
import { scanRepo } from '../../core/src/scan/node.ts';

const SERVER_NAME = 'archforge';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

// ---------------------------------------------------------------------- types

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<string>;
}

// ------------------------------------------------------------------- helpers

/** Default source path, overridable per call and by `ARCH_SOURCE`. */
const defaultSource = (): string => process.env['ARCH_SOURCE'] ?? '.archforge/architecture.arch';

function stringArg(args: Record<string, unknown>, name: string, fallback?: string): string {
  const value = args[name];
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`\`${name}\` is required`);
}

function boolArg(args: Record<string, unknown>, name: string): boolean {
  return args[name] === true || args[name] === 'true';
}

async function readSource(path: string): Promise<{ file: string; text: string }> {
  const absolute = resolve(path);
  const text = await readFile(absolute, 'utf8');
  return { file: relative(process.cwd(), absolute).split('\\').join('/'), text };
}

function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  if (diagnostics.length === 0) return '';
  return sortDiagnostics(diagnostics)
    .map((d) => {
      const location = d.loc ? `${d.loc.file}:${d.loc.line}:${d.loc.column} ` : '';
      return `${location}${d.severity}: ${d.message}${d.hint ? `\n  hint: ${d.hint}` : ''}`;
    })
    .join('\n');
}

/** Compiles source text, throwing a readable error when it does not compile. */
function modelFrom(file: string, text: string): ArchModel {
  const result = compileFiles([{ file, text }]);
  if (hasErrors(result.diagnostics)) {
    throw new Error(`the model does not compile:\n${formatDiagnostics(result.diagnostics)}`);
  }
  return new ArchModel(result.workspace);
}

async function loadModel(args: Record<string, unknown>): Promise<ArchModel> {
  const source = await readSource(stringArg(args, 'source', defaultSource()));
  return modelFrom(source.file, source.text);
}

// --------------------------------------------------------------------- tools

const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'get_model',
    description:
      'Read the current architecture model as canonical JSON: elements, relationships, views and rules. Start here to learn what exists before proposing a change.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Path to the .arch file. Defaults to .archforge/architecture.arch.' },
        summary: { type: 'boolean', description: 'Return a compact tree instead of full JSON.' },
      },
    },
    async handler(args) {
      const model = await loadModel(args);
      if (!boolArg(args, 'summary')) return canonicalJson(model.workspace);

      const lines: string[] = [`${model.workspace.name} — ${model.elements.length} elements`];
      const walk = (id: string, depth: number): void => {
        const element = model.requireElement(id);
        lines.push(
          `${'  '.repeat(depth)}${element.id}  ${element.name} [${element.subtype ?? element.kind}${
            element.technology ? `: ${element.technology}` : ''
          }]`,
        );
        for (const child of model.children(id)) walk(child.id, depth + 1);
      };
      for (const root of model.roots()) walk(root.id, 0);
      lines.push('', 'Relationships:');
      for (const relation of model.relations) {
        lines.push(`  ${relation.sourceId} -> ${relation.destId}  ${relation.description ?? ''}`);
      }
      lines.push('', `Views: ${model.views.map((v) => `${v.id} (${v.kind})`).join(', ')}`);
      lines.push(`Rules: ${model.rules.map((r) => r.id).join(', ')}`);
      return lines.join('\n');
    },
  },

  {
    name: 'query',
    description:
      'Find elements with a selector, e.g. `element(kind:container,tag:internal)`, `element(in:payments)`, `tag:external`, or `*`. Use this instead of reading the whole model when you only need part of it.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Selector expression.' },
        source: { type: 'string' },
      },
      required: ['selector'],
    },
    async handler(args) {
      const model = await loadModel(args);
      const parsed = parseSelector(stringArg(args, 'selector'));
      if (parsed.errors.length > 0) throw new Error(parsed.errors.join('; '));
      const found = select(parsed.selector, model);
      return canonicalJson({
        selector: parsed.selector.text,
        count: found.length,
        elements: found.map((element) => ({
          id: element.id,
          name: element.name,
          kind: element.kind,
          subtype: element.subtype,
          technology: element.technology,
          owner: element.owner,
          tags: element.tags,
        })),
      });
    },
  },

  {
    name: 'validate',
    description:
      'Evaluate the architecture rules and report violations with source locations. Run this after every proposed change; a proposal that fails validation should be revised, not applied.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        recommended: { type: 'boolean', description: 'Also apply the recommended rule set.' },
      },
    },
    async handler(args) {
      const model = await loadModel(args);
      const result = check(model, boolArg(args, 'recommended') ? RECOMMENDED_RULES : []);
      return canonicalJson({
        ok: result.summary.errors === 0,
        summary: result.summary,
        violations: result.violations,
        ruleErrors: result.ruleErrors,
      });
    },
  },

  {
    name: 'impact',
    description:
      'Answer "what breaks if I change this?" — direct and transitive dependents of an element, what it depends on, and which systems are affected.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Element id, e.g. payments.db.' },
        source: { type: 'string' },
      },
      required: ['id'],
    },
    async handler(args) {
      const model = await loadModel(args);
      const id = stringArg(args, 'id');
      const element = model.element(id);
      if (!element) throw new Error(`unknown element \`${id}\``);
      return canonicalJson({
        element: element.id,
        directDependents: model.dependents(element.id, { transitive: false }).map((e) => e.id),
        transitiveDependents: model.dependents(element.id).map((e) => e.id),
        dependencies: model.dependencies(element.id).map((e) => e.id),
        affectedSystems: [
          ...new Set(
            model
              .dependents(element.id)
              .map((e) => model.ancestorOfKind(e.id, 'system')?.id ?? e.id),
          ),
        ].sort(),
        cycles: model.cycles().filter((cycle) => cycle.includes(element.id)),
      });
    },
  },

  {
    name: 'list_views',
    description: 'List the views defined in the model and how many elements and relationships each derives.',
    inputSchema: { type: 'object', properties: { source: { type: 'string' } } },
    async handler(args) {
      const model = await loadModel(args);
      return canonicalJson(
        deriveAll(model).map((view) => ({
          id: view.id,
          kind: view.kind,
          title: view.title,
          scopeId: view.scopeId,
          elements: view.nodes.length,
          relationships: view.edges.length,
        })),
      );
    },
  },

  {
    name: 'render',
    description:
      'Render a view. Formats: svg (self-contained, themeable), puml (self-contained PlantUML), mermaid, json. Returns the text; pass `out` to also write it to a file.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', description: 'View id. Use list_views to discover.' },
        format: { type: 'string', enum: ['svg', 'puml', 'mermaid', 'json'] },
        direction: { type: 'string', enum: ['TB', 'LR'] },
        out: { type: 'string', description: 'Optional file path to write to.' },
        source: { type: 'string' },
      },
      required: ['view'],
    },
    async handler(args) {
      const model = await loadModel(args);
      const viewId = stringArg(args, 'view');
      const definition = model.views.find((candidate) => candidate.id === viewId);
      if (!definition) {
        throw new Error(
          `unknown view \`${viewId}\`. Available: ${model.views.map((v) => v.id).join(', ') || '(none)'}`,
        );
      }
      const view = derive(model, definition);
      const direction = stringArg(args, 'direction', 'TB') === 'LR' ? 'LR' : 'TB';
      const format = stringArg(args, 'format', 'svg');

      let content: string;
      switch (format) {
        case 'puml':
          content = toPlantUml(model, view, { direction });
          break;
        case 'mermaid':
          content = toMermaid(view, { direction });
          break;
        case 'json':
          content = canonicalJson({ view, layout: layout(view, { direction }) });
          break;
        default:
          content = renderSvg(view, layout(view, { direction }), {
            workspaceName: model.workspace.name,
          });
      }

      const out = typeof args['out'] === 'string' ? args['out'] : undefined;
      if (out) {
        await writeFile(resolve(out), content, 'utf8');
        return `Wrote ${out} (${content.length} bytes).`;
      }
      return content;
    },
  },

  {
    name: 'docs',
    description:
      'Generate Markdown architecture documentation from the model: overview, per-view tables, technology inventory, ownership map and dependency table.',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string' }, out: { type: 'string' } },
    },
    async handler(args) {
      const model = await loadModel(args);
      const markdown = documentWorkspace(model, deriveAll(model), {});
      const out = typeof args['out'] === 'string' ? args['out'] : undefined;
      if (out) {
        await writeFile(resolve(out), markdown, 'utf8');
        return `Wrote ${out}.`;
      }
      return markdown;
    },
  },

  {
    name: 'scan_repository',
    description:
      'Scan a source repository and report the architecture it can infer: components, infrastructure dependencies and relationships, each with file:line evidence and a confidence class. Works across Java/Kotlin, JavaScript/TypeScript, Python, Go, .NET, Ruby, PHP, Rust, dependency manifests, Dockerfiles, Compose, Kubernetes and Terraform. Inferred facts are never the same as declared ones.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository root. Defaults to the working directory.' },
        include: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict to these repo-relative path prefixes.',
        },
      },
    },
    async handler(args) {
      const include = Array.isArray(args['include'])
        ? (args['include'] as unknown[]).filter((value): value is string => typeof value === 'string')
        : undefined;
      const scan = await scanRepo({ root: resolve(stringArg(args, 'repo', '.')), include });
      return canonicalJson({
        languages: scan.languages,
        scannersRun: scan.scannersRun,
        filesScanned: scan.files.length,
        components: scan.components,
        externals: scan.externals,
        relations: scan.relations,
      });
    },
  },

  {
    name: 'drift',
    description:
      'Compare the declared model against a real repository and report drift: undocumented dependencies, declared dependencies with no supporting code, and elements with no `source` binding. This is the check to run before claiming a diagram is accurate.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        source: { type: 'string' },
        minConfidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
    },
    async handler(args) {
      const model = await loadModel(args);
      const scan = await scanRepo({ root: resolve(stringArg(args, 'repo', '.')) });
      const minConfidence = stringArg(args, 'minConfidence', 'medium');
      const report = detectDrift({
        model,
        scan,
        minConfidence: minConfidence === 'low' || minConfidence === 'high' ? minConfidence : 'medium',
      });
      return canonicalJson(report);
    },
  },

  {
    name: 'propose',
    description:
      'Review a proposed change WITHOUT writing anything. Give the complete new source text; the tool compiles it, evaluates the rules, and returns a structural diff against the current model. Always call this before `apply`, and show the diff to the human.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The complete proposed .arch source.' },
        source: { type: 'string', description: 'Existing file to compare against.' },
      },
      required: ['text'],
    },
    async handler(args) {
      const path = stringArg(args, 'source', defaultSource());
      const proposedText = stringArg(args, 'text');

      let current: ArchModel | undefined;
      try {
        const existing = await readSource(path);
        current = modelFrom(existing.file, existing.text);
      } catch {
        current = undefined; // Proposing a brand-new model is legitimate.
      }

      const compiled = compileFiles([{ file: path, text: proposedText }]);
      if (hasErrors(compiled.diagnostics)) {
        return canonicalJson({
          ok: false,
          stage: 'compile',
          diagnostics: sortDiagnostics(compiled.diagnostics),
          message: 'The proposal does not compile; it was not applied. Fix these and propose again.',
        });
      }

      const proposed = new ArchModel(compiled.workspace);
      const verdict = check(proposed);
      const structural = current ? diff(current, proposed) : undefined;

      return canonicalJson({
        ok: verdict.summary.errors === 0,
        stage: 'review',
        applied: false,
        validation: { summary: verdict.summary, violations: verdict.violations },
        diff: structural,
        diffText: structural ? formatDiff(structural) : '(new model)',
        message:
          verdict.summary.errors === 0
            ? 'Proposal compiles and passes the rules. Show the diff to the human, then call `apply` with confirm=true.'
            : 'Proposal compiles but VIOLATES architecture rules. Revise it rather than applying.',
      });
    },
  },

  {
    name: 'apply',
    description:
      'Write a proposed change to disk. Requires confirm=true and refuses proposals that do not compile or that break error-severity rules. Only call this after a human has seen the `propose` diff.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The complete new .arch source.' },
        source: { type: 'string', description: 'File to write.' },
        confirm: { type: 'boolean', description: 'Must be true. Guards against accidental writes.' },
        allowViolations: {
          type: 'boolean',
          description: 'Write even when rules fail. Use only on explicit human instruction.',
        },
      },
      required: ['text', 'confirm'],
    },
    async handler(args) {
      if (!boolArg(args, 'confirm')) {
        throw new Error(
          'refusing to write without confirm=true. Call `propose` first and have a human review the diff.',
        );
      }
      const path = stringArg(args, 'source', defaultSource());
      const text = stringArg(args, 'text');

      const compiled = compileFiles([{ file: path, text }]);
      if (hasErrors(compiled.diagnostics)) {
        throw new Error(
          `refusing to write a model that does not compile:\n${formatDiagnostics(compiled.diagnostics)}`,
        );
      }
      const proposed = new ArchModel(compiled.workspace);
      const verdict = check(proposed);
      if (verdict.summary.errors > 0 && !boolArg(args, 'allowViolations')) {
        throw new Error(
          `refusing to write: ${verdict.summary.errors} rule violation(s).\n` +
            verdict.violations
              .filter((violation) => violation.severity === 'error')
              .map((violation) => `  ${violation.ruleId}: ${violation.message}`)
              .join('\n') +
            '\nRevise the proposal, or pass allowViolations=true if a human has explicitly accepted this.',
        );
      }

      const absolute = resolve(path);
      await writeFile(absolute, text, 'utf8');
      return canonicalJson({
        applied: true,
        file: relative(process.cwd(), absolute),
        elements: proposed.elements.length,
        relationships: proposed.relations.length,
        warnings: verdict.summary.warnings,
      });
    },
  },

  {
    name: 'diff_models',
    description:
      'Structural diff between two model files, e.g. a branch and main. Reports added, removed and changed elements and relationships rather than text lines.',
    inputSchema: {
      type: 'object',
      properties: {
        before: { type: 'string' },
        after: { type: 'string' },
      },
      required: ['before', 'after'],
    },
    async handler(args) {
      const beforeSource = await readSource(stringArg(args, 'before'));
      const afterSource = await readSource(stringArg(args, 'after'));
      const result = diff(
        modelFrom(beforeSource.file, beforeSource.text),
        modelFrom(afterSource.file, afterSource.text),
      );
      return canonicalJson({ summary: result.summary, diff: result, text: formatDiff(result) });
    },
  },

  {
    name: 'dsl_reference',
    description:
      'The DSL grammar, with a worked example and the selector and rule syntax. Read this before writing or editing a model so proposals compile first time.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      return DSL_REFERENCE;
    },
  },
];

// ------------------------------------------------------------------ dispatch

async function handle(request: JsonRpcRequest): Promise<unknown> {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          'Architecture as code. Read with get_model/query/list_views. Understand consequences with impact, validate and drift. ' +
          'To change the architecture: call dsl_reference, then propose the complete new source, show the returned diff to the human, ' +
          'and only then call apply with confirm=true. Never fabricate a confidence score; inferred facts come from scan_repository and carry evidence.',
      };

    case 'tools/list':
      return {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };

    case 'tools/call': {
      const name = request.params?.['name'];
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`unknown tool \`${String(name)}\``);
      const args = (request.params?.['arguments'] as Record<string, unknown>) ?? {};
      try {
        const text = await tool.handler(args);
        return { content: [{ type: 'text', text }], isError: false };
      } catch (error) {
        // Tool failures are returned as content, not as protocol errors, so the
        // agent can read the message and correct itself rather than stalling.
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    }

    case 'ping':
      return {};

    default:
      throw new Error(`unsupported method \`${request.method}\``);
  }
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function main(): void {
  const input = createInterface({ input: process.stdin });

  /**
   * In-flight request count. stdin closing does NOT mean the work is done:
   * a client may write a batch of requests and close the pipe immediately,
   * and exiting at that moment would silently drop every pending answer.
   */
  let pending = 0;
  let inputClosed = false;

  const exitWhenIdle = (): void => {
    if (inputClosed && pending === 0) process.exit(0);
  };

  input.on('line', (line: string) => {
    const trimmed = line.trim();
    if (trimmed === '') return;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }

    // Notifications have no id and must not be answered.
    const isNotification = request.id === undefined || request.id === null;

    pending += 1;
    handle(request).then(
      (result) => {
        if (!isNotification) send({ jsonrpc: '2.0', id: request.id, result });
        pending -= 1;
        exitWhenIdle();
      },
      (error: unknown) => {
        if (!isNotification) {
          send({
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        pending -= 1;
        exitWhenIdle();
      },
    );
  });

  input.on('close', () => {
    inputClosed = true;
    exitWhenIdle();
  });
}

void dirname; // reserved for future relative-path resolution
main();

// ---------------------------------------------------------------- reference

const DSL_REFERENCE = `ARCHFORGE DSL REFERENCE

A model is one or more .arch files. The model is the source of truth; every
diagram is derived from it. Layout is stored separately and never in here.

STRUCTURE
  workspace "Name" {
    description "..."               // or """ multi-line """

    person customer "Customer" { description "..." }

    system payments "Payment Platform" {
      description "..."
      owner "team-payments"
      tag domain-payment

      container api "Payment API" {
        technology "Java 21 / Spring Boot"
        kind api                    // subtype: api|service|database|queue|topic|cache|browser|mobileApp|function
        source "services/payment-api"   // binds to code; REQUIRED for drift detection
        tag internal

        component controller "PaymentController" { technology "Spring Web" }
      }

      database db "Payments DB" { technology "PostgreSQL 16" }
      topic events "payment.events" { technology "Apache Kafka" }
    }
  }

Nesting is enforced: person and system at top level, container inside system,
component inside container. The sugar keywords (database, queue, topic, cache,
api, service, browser, mobileApp, function) take their structural kind from
where they appear, so \`database\` inside a system is a container.

DEPLOYMENT
  deploymentNode aws "AWS eu-central-1" {
    technology "AWS"
    deploymentNode eks "EKS" {
      deploymentNode apiPod "payment-api" { instanceOf payments.api instances "3" }
    }
    infrastructureNode rds "RDS PostgreSQL" { instanceOf payments.db }
  }

RELATIONSHIPS  (declare once, at the level you actually know)
  customer -> payments.api "Pays" { technology "HTTPS/JSON" tag sync }
  a <-> b "Syncs"                      // bidirectional

References resolve relative to the enclosing scope, then absolutely, then by
unique suffix, so \`db\` works where it is unambiguous. Ambiguity is an error
listing the candidates, never a silent guess.

VIEWS  (projections; never duplicate model data)
  views {
    context landscape "System landscape" of payments
    container platform "Containers" of payments
    component apiInternals "API components" of payments.api
    deployment production "Production" of aws
    dynamic checkout "Taking a payment" {
      customer -> payments.web "Submits card"
      payments.web -> payments.api "POST /payments"
    }
  }
  Optional inside a view body: include <selector>, exclude <selector>, title "...".

SELECTORS  (predicates are ANDed; values support * globs)
  *                                    everything
  tag:internal                         shorthand for one predicate
  element(kind:container, tag:internal)
  Predicates: tag, kind, id, name, owner, tech, in, source, provenance
  \`kind\` matches the structural kind or the subtype. \`in:payments\` matches the
  element and everything inside it.

RULES  (deterministic, explainable, gate CI)
  rules {
    rule no-cycles "Architecture must be acyclic" {
      severity error                   // error | warning | info
      forbid cycles
    }
    rule domains "Order must not reach payment internals" {
      severity error
      forbid element(tag:domain-order) -> element(tag:internal, tag:domain-payment)
    }
    rule only-via-api "The web app may only call the API" {
      severity error
      allow element(id:payments.web) -> element(kind:api)
    }
    rule owned {
      severity warning
      require owner on element(kind:container)
    }
    rule connected { severity warning  forbid orphans }
  }
  require fields: description | technology | owner | source
  forbid: cycles [in <selector>] | orphans [in <selector>] | <selector> -> <selector>
  allow is a whitelist: matching sources may depend ONLY on matching targets.

PROPERTIES
  Elements: description, technology, owner, url, kind/subtype, icon, source,
            instanceOf, instances, tag/tags, external, prop <key> "<value>"
  Relations: description, technology, protocol, tag/tags, prop
  \`tag a, b\` is comma-separated. \`external\` is a flag.

WORKFLOW FOR AN AGENT
  1. get_model / query      — learn what exists
  2. impact                 — check what a change would affect
  3. propose <full text>    — compile + validate + diff, writes nothing
  4. show the diff to the human
  5. apply confirm=true     — only after review
`;
