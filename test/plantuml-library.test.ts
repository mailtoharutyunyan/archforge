/**
 * Renders the PlantUML macro library with the real PlantUML binary.
 *
 * The macros are a *product*, not a generated artefact, so the only meaningful
 * test is whether PlantUML accepts them. Rendering caught three defects that
 * no amount of reading would have: stereotypes printing on every element, a
 * deprecated skinparam drawing a warning into the image, and include guards
 * that never fired because `%variable_exists("$NAME")` substitutes the value.
 *
 * Skipped when PlantUML is not installed, so the suite still runs anywhere.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HAVE_PLANTUML = (() => {
  const probe = spawnSync('plantuml', ['-version'], { encoding: 'utf8' });
  return probe.status === 0;
})();

const SKIP = HAVE_PLANTUML ? undefined : 'plantuml is not installed';

/** Renders a .puml file and returns the text PlantUML actually drew. */
function render(puml: string): { text: string; svg: string } {
  const dir = mkdtempSync(join(tmpdir(), 'arch-puml-'));
  try {
    const file = join(dir, 'diagram.puml');
    writeFileSync(file, puml);

    const result = spawnSync(
      'plantuml',
      ['-DRELATIVE_INCLUDE=.', '-tsvg', '-o', dir, file],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `plantuml failed: ${result.stderr}`);

    const svgName = readdirSync(dir).find((name) => name.endsWith('.svg'));
    assert.ok(svgName, 'plantuml produced no SVG');
    const svg = readFileSync(join(dir, svgName), 'utf8');

    const text = [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/gs)]
      .map((match) => match[1] ?? '')
      .join(' ')
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ');

    return { text, svg };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The library lives here; tests include it by absolute path. */
const LIB = join(process.cwd(), 'assets', 'plantuml');

function assertClean(text: string): void {
  assert.equal(/syntax error/i.test(text), false, 'PlantUML reported a syntax error');
  assert.equal(/cannot include/i.test(text), false, 'an include failed to resolve');
  assert.equal(text.includes('«'), false, 'a stereotype leaked into the drawing');
  assert.equal(
    text.includes('Please use CSS'),
    false,
    'a deprecation warning was drawn into the image',
  );
  assert.equal(
    text.includes('Welcome to PlantUML'),
    false,
    'PlantUML fell back to its welcome diagram, so the input was rejected',
  );
}

test('the context level renders', { skip: SKIP }, () => {
  const { text } = render(`@startuml
!include ${LIB}/Arch_Context.puml
LAYOUT_TOP_DOWN()
Person(customer, "Customer", "Buys things")
Person_Ext(auditor, "Auditor", "Reviews reports")
System(platform, "Platform", "Does the work")
System_Ext(cards, "Card Network", "Authorises cards")
SystemDb_Ext(ledger, "Ledger", "Books")
SystemQueue(bus, "Event bus", "Events")
Rel(customer, platform, "Uses", "HTTPS")
BiRel(platform, cards, "Authorises", "HTTPS")
Rel_Async(platform, bus, "Publishes", "Kafka")
SHOW_LEGEND()
@enduml`);

  assertClean(text);
  for (const expected of ['Customer', 'Auditor', 'Platform', 'Card Network', 'Ledger', 'Event bus']) {
    assert.ok(text.includes(expected), `${expected} should be drawn`);
  }
  assert.ok(text.includes('[external]'), 'external elements are marked');
});

test('the container level renders, including boundaries', { skip: SKIP }, () => {
  const { text, svg } = render(`@startuml
!include ${LIB}/Arch_Container.puml
LAYOUT_TOP_DOWN()
Person(customer, "Customer")
System_Boundary(payments, "Payment Platform") {
  ContainerBrowser(web, "Web checkout", "TypeScript / React", "Checkout flow")
  ContainerApi(api, "Payment API", "Java 21 / Spring Boot", "Authorises")
  ContainerDb(db, "Payments DB", "PostgreSQL 16", "Stores payments")
  ContainerCache(cache, "Idempotency", "Redis 7")
  ContainerTopic(events, "payment.events", "Apache Kafka")
  ContainerFunction(fn, "Webhook handler", "AWS Lambda")
}
Container_Ext(notify, "Notifications", "HTTP")
Rel(customer, web, "Pays", "HTTPS")
Rel(api, db, "Reads and writes", "JDBC")
Rel_Async(api, events, "Publishes", "Kafka")
@enduml`);

  assertClean(text);
  assert.ok(text.includes('Payment Platform'), 'the boundary is labelled');
  assert.ok(text.includes('[system]'), 'the boundary states its type');
  for (const expected of [
    'Web checkout',
    'Payment API',
    'Java 21 / Spring Boot',
    'Payments DB',
    'PostgreSQL 16',
    'Idempotency',
    'payment.events',
    'Webhook handler',
  ]) {
    assert.ok(text.includes(expected), `${expected} should be drawn`);
  }

  // Our palette must actually reach the output.
  const upper = svg.toUpperCase();
  assert.ok(upper.includes('0D9488'), 'api colour applied');
  assert.ok(upper.includes('7C3AED'), 'database colour applied');
  assert.ok(upper.includes('DB2777'), 'cache colour applied');
  // Sprites are embedded as images.
  assert.ok(svg.includes('<image'), 'structural sprites are drawn');
});

test('the component level renders inside a container boundary', { skip: SKIP }, () => {
  const { text } = render(`@startuml
!include ${LIB}/Arch_Component.puml
Container_Boundary(api, "Payment API") {
  ComponentApi(controller, "PaymentController", "Spring Web", "REST endpoints")
  ComponentService(service, "PaymentService", "Spring")
  ComponentDb(repo, "PaymentRepository", "Spring Data JPA")
  ComponentQueue(pub, "EventPublisher", "Spring Kafka")
}
Rel(controller, service, "Delegates")
@enduml`);

  assertClean(text);
  assert.ok(text.includes('[container]'), 'a container boundary states its type');
  assert.ok(text.includes('PaymentController'));
  assert.ok(text.includes('Spring Data JPA'));
});

test('the deployment level nests nodes', { skip: SKIP }, () => {
  const { text } = render(`@startuml
!include ${LIB}/Arch_Deployment.puml
Deployment_Node(aws, "AWS", "eu-central-1") {
  Deployment_Node(eks, "EKS", "Kubernetes 1.31") {
    Container(api, "Payment API", "Java 21", "3 replicas")
  }
  Infrastructure_Node(rds, "RDS", "PostgreSQL, Multi-AZ")
}
Rel(api, rds, "Reads and writes", "JDBC")
@enduml`);

  assertClean(text);
  for (const expected of ['AWS', 'eu-central-1', 'Kubernetes 1.31', 'Multi-AZ', '3 replicas']) {
    assert.ok(text.includes(expected), `${expected} should be drawn`);
  }
});

test('dynamic interactions are numbered in order', { skip: SKIP }, () => {
  const { text } = render(`@startuml
!include ${LIB}/Arch_Dynamic.puml
Person(customer, "Customer")
ContainerApi(api, "API", "Java")
ContainerDb(db, "DB", "PostgreSQL")
RelIndex(customer, api, "Submits", "HTTPS")
RelIndex(api, db, "Persists", "JDBC")
RelIndex(api, customer, "Responds", "HTTPS")
@enduml`);

  assertClean(text);
  for (const step of ['1.', '2.', '3.']) {
    assert.ok(text.includes(step), `step ${step} should be numbered`);
  }
  assert.ok(text.includes('Submits') && text.includes('Persists'));
});

test('including two levels at once is harmless', { skip: SKIP }, () => {
  // The include guards must stop a second definition pass; a `$` inside
  // %variable_exists() made them silently never fire.
  const { text } = render(`@startuml
!include ${LIB}/Arch_Container.puml
!include ${LIB}/Arch_Component.puml
!include ${LIB}/Arch_Deployment.puml
System_Boundary(s, "S") {
  Container(c, "C", "Go")
  Container_Boundary(cb, "C internals") {
    Component(x, "X", "Go")
  }
}
Rel(c, x, "uses")
@enduml`);

  assertClean(text);
  assert.ok(text.includes('C internals'));
  assert.ok(text.includes('X'));
});

test('every shipped example renders', { skip: SKIP }, () => {
  for (const name of ['context', 'container', 'component', 'deployment', 'dynamic']) {
    const source = readFileSync(join('examples', 'plantuml', `${name}.puml`), 'utf8');
    // The examples use a relative include; rewrite it to the absolute library
    // path so the test does not depend on the working directory.
    const rewritten = source.replace(
      /!include\s+\.\.\/\.\.\/assets\/plantuml\//g,
      `!include ${LIB}/`,
    );
    const { text } = render(rewritten);
    assertClean(text);
    assert.ok(text.length > 40, `${name}.puml produced almost no text`);
  }
});

test('the generated sprite file is valid and complete', { skip: SKIP }, () => {
  const sprites = readFileSync(join(LIB, 'Arch_Sprites.puml'), 'utf8');
  const names = [...sprites.matchAll(/^sprite \$(\w+) \[(\d+)x(\d+)\/16\]/gm)];
  assert.ok(names.length >= 15, 'the sprite set should be complete');

  for (const match of names) {
    const [, name, width, height] = match;
    assert.ok(name?.startsWith('arch_'), `${name} should be namespaced`);
    assert.equal(width, '16');
    assert.equal(height, '16');
  }

  // Each sprite body must be exactly 16 rows of 16 hex digits, or PlantUML
  // renders a corrupted glyph rather than failing loudly.
  for (const block of sprites.split('sprite $').slice(1)) {
    const body = block.slice(block.indexOf('{') + 1, block.indexOf('}'));
    const rows = body.trim().split('\n');
    assert.equal(rows.length, 16, 'a sprite must have 16 rows');
    for (const row of rows) {
      assert.match(row.trim(), /^[0-9A-F]{16}$/, `bad sprite row: ${row}`);
    }
  }

  // And it must actually render.
  const { svg } = render(`@startuml
!include ${LIB}/Arch_Sprites.puml
rectangle "<$arch_database>\\n<b>DB</b>" as a
rectangle "<$arch_topic>\\n<b>Topic</b>" as b
a --> b
@enduml`);
  assert.ok(svg.includes('<image'), 'sprites render as images');
});
