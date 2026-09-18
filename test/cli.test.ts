/**
 * End-to-end tests for the `arch` command and the MCP server.
 *
 * These run the real binaries as a user would, because the interesting
 * failures at this level are not logic errors — they are exit codes, stream
 * discipline (progress on stderr, data on stdout) and whether the thing starts
 * at all. None of that is visible from a unit test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = 'packages/cli/src/main.ts';
const MCP = 'packages/mcp/src/server.ts';
const SMALL = 'examples/payment-platform/architecture.arch';
const LARGE = 'examples/globex-commerce/architecture.arch';

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function arch(...args: string[]): Run {
  const result = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function temporaryDir(): string {
  return mkdtempSync(join(tmpdir(), 'archforge-test-'));
}

test('arch check passes on both examples and exits 0', () => {
  for (const source of [SMALL, LARGE]) {
    const result = arch('check', source);
    assert.equal(result.status, 0, `${source} should pass:\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /All \d+ rules pass/);
  }
});

test('arch check exits 1 on a rule violation and names the rule', () => {
  const dir = temporaryDir();
  try {
    const file = join(dir, 'violation.arch');
    writeFileSync(
      file,
      `workspace "V" {
        system a "A" { tag domain-a
          container x "X" { technology "Go" }
        }
        system b "B" { tag domain-b
          database d "D" { technology "PostgreSQL" tag secret }
        }
        a.x -> b.d "reaches in"
        rules {
          rule isolation "No cross-domain data access" {
            severity error
            forbid element(tag:domain-a) -> element(tag:secret)
          }
        }
      }`,
    );

    const result = arch('check', file);
    assert.equal(result.status, 1, 'a violated error rule must fail the build');
    assert.match(result.stdout, /isolation/);
    assert.match(result.stdout, /must not depend on/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arch check exits 3 when the model does not compile', () => {
  const dir = temporaryDir();
  try {
    const file = join(dir, 'broken.arch');
    writeFileSync(file, 'workspace "B" {\n  container loose "Loose"\n}');
    const result = arch('check', file);
    assert.equal(result.status, 3, 'a model that does not compile is a distinct failure');
    assert.match(result.stderr, /must be declared inside a system/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arch check --json emits machine-readable output only', () => {
  const result = arch('check', SMALL, '--json');
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as { ok: boolean; summary: { elements: number } };
  assert.equal(parsed.ok, true);
  assert.ok(parsed.summary.elements > 0);
});

test('arch render writes every view and is byte-deterministic', () => {
  const dir = temporaryDir();
  try {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    assert.equal(arch('render', LARGE, '--all', '--out', a).status, 0);
    assert.equal(arch('render', LARGE, '--all', '--out', b).status, 0);

    const files = readdirSync(a).sort();
    assert.ok(files.length >= 10, 'every view should render');
    for (const file of files) {
      assert.equal(
        readFileSync(join(a, file), 'utf8'),
        readFileSync(join(b, file), 'utf8'),
        `${file} must be identical between runs`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arch render supports puml, mermaid and json', () => {
  const dir = temporaryDir();
  try {
    for (const [format, extension, marker] of [
      ['puml', 'puml', '@startuml'],
      ['mermaid', 'mmd', ''],
      ['json', 'json', '"view"'],
    ] as const) {
      const out = join(dir, format);
      assert.equal(arch('render', SMALL, '--all', '--format', format, '--out', out).status, 0);
      const files = readdirSync(out);
      assert.ok(files.length > 0, `${format} produced files`);
      assert.ok(files.every((file) => file.endsWith(`.${extension}`)), `${format} extension`);
      if (marker) {
        const content = readFileSync(join(out, files[0] as string), 'utf8');
        assert.ok(content.includes(marker), `${format} content looks right`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arch drift finds the planted undocumented dependency and exits 1', () => {
  const result = arch('drift', SMALL, '--repo', 'examples/payment-platform', '--json');
  assert.equal(result.status, 1, 'known drift must fail the build');

  const report = JSON.parse(result.stdout) as {
    findings: { kind: string; message: string; confidence?: string; evidence: unknown[] }[];
  };
  const undocumented = report.findings.find((finding) => finding.kind === 'undocumented-dependency');
  assert.ok(undocumented, 'the Redis dependency should be reported');
  assert.match(undocumented.message, /Redis/);
  assert.equal(undocumented.confidence, 'high');
  assert.ok(undocumented.evidence.length > 0, 'a finding must carry evidence');
});

test('arch analyze produces a model that compiles, with progress off stdout', () => {
  const dir = temporaryDir();
  try {
    const result = arch('analyze', 'examples/payment-platform');
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^workspace /, 'stdout must start with the model, not a log line');
    assert.match(result.stderr, /Scanning/, 'progress belongs on stderr');

    const file = join(dir, 'generated.arch');
    writeFileSync(file, result.stdout);
    const check = arch('check', file);
    assert.equal(check.status, 0, `generated model should compile and pass:\n${check.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arch diff reports changes and honours --exit-code', () => {
  const dir = temporaryDir();
  try {
    const before = join(dir, 'before.arch');
    const after = join(dir, 'after.arch');
    const base = `workspace "D" {
      system s "S" { container a "A" { technology "Go" } }
      system t "T" { }
      s.a -> t "calls"
    }`;
    writeFileSync(before, base);
    writeFileSync(after, base.replace('technology "Go"', 'technology "Rust"'));

    const plain = arch('diff', before, after);
    assert.equal(plain.status, 0, 'without --exit-code a diff is informational');
    assert.match(plain.stdout, /Go.*Rust|Rust/s);

    const gated = arch('diff', before, after, '--exit-code');
    assert.equal(gated.status, 1, 'with --exit-code a non-empty diff fails');

    const same = arch('diff', before, before, '--exit-code');
    assert.equal(same.status, 0);
    assert.match(same.stdout, /No architectural changes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arch impact answers what depends on an element', () => {
  const result = arch('impact', SMALL, 'payments.db', '--json');
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as {
    directDependents: string[];
    transitiveDependents: string[];
  };
  assert.ok(parsed.directDependents.length > 0);
  assert.ok(parsed.transitiveDependents.length >= parsed.directDependents.length);
});

test('arch docs writes markdown and diagrams', () => {
  const dir = temporaryDir();
  try {
    const result = arch('docs', SMALL, '--out', dir);
    assert.equal(result.status, 0);
    const markdown = readFileSync(join(dir, 'ARCHITECTURE.md'), 'utf8');
    assert.match(markdown, /^# Payment Platform/m);
    assert.ok(readdirSync(join(dir, 'diagrams')).length > 0, 'diagrams are written alongside');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arch init scaffolds a workspace that passes its own checks', () => {
  const dir = temporaryDir();
  try {
    const target = join(dir, '.archforge');
    assert.equal(arch('init', target).status, 0);
    const check = arch('check', join(target, 'architecture.arch'));
    assert.equal(check.status, 0, `the scaffold should pass:\n${check.stdout}${check.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arch reports unknown commands and bad usage without crashing', () => {
  const unknown = arch('nonsense');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command/);

  const missing = arch('check', 'does/not/exist.arch');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read/);

  const help = arch('help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /USAGE/);
});

test('the MCP server initialises, lists tools and refuses unconfirmed writes', () => {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_model', arguments: { source: SMALL, summary: true } },
    },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'apply',
        arguments: { source: SMALL, text: 'workspace "X" {}', confirm: false },
      },
    },
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'propose', arguments: { source: SMALL, text: 'workspace "X" { person p "P" }' } },
    },
  ];

  const result = spawnSync('node', [MCP], {
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);

  const responses = new Map<number, { result?: Record<string, unknown> }>();
  for (const line of (result.stdout ?? '').trim().split('\n')) {
    const message = JSON.parse(line) as { id: number; result?: Record<string, unknown> };
    responses.set(message.id, message);
  }

  const init = responses.get(1)?.result as { serverInfo?: { name?: string } } | undefined;
  assert.equal(init?.serverInfo?.name, 'archforge');

  const tools = responses.get(2)?.result as { tools?: { name: string }[] } | undefined;
  const names = (tools?.tools ?? []).map((tool) => tool.name);
  for (const expected of ['get_model', 'query', 'validate', 'drift', 'propose', 'apply']) {
    assert.ok(names.includes(expected), `${expected} should be exposed`);
  }

  const model = responses.get(3)?.result as { content?: { text: string }[] } | undefined;
  assert.match(model?.content?.[0]?.text ?? '', /Payment Platform/);

  // Writing without confirm=true must be refused, not performed.
  const apply = responses.get(4)?.result as
    | { isError?: boolean; content?: { text: string }[] }
    | undefined;
  assert.equal(apply?.isError, true, 'apply without confirmation must fail');
  assert.match(apply?.content?.[0]?.text ?? '', /confirm=true/);

  // The example file must be untouched by the refused write.
  assert.match(readFileSync(SMALL, 'utf8'), /workspace "Payment Platform"/);

  // propose must report without applying.
  const propose = responses.get(5)?.result as { content?: { text: string }[] } | undefined;
  const parsed = JSON.parse(propose?.content?.[0]?.text ?? '{}') as { applied?: boolean };
  assert.equal(parsed.applied, false, 'propose never writes');
});
