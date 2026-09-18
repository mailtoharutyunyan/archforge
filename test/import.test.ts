/**
 * Tests for the PlantUML importer.
 *
 * Two properties matter most. First, detection: pasting PlantUML into the
 * `.arch` editor must be recognised as a different language, not reported as
 * eighty syntax errors. Second, the import must always produce a model that
 * *compiles* — C4-PlantUML allows structures our model does not, so the
 * importer has to repair them, and a repair that produces an invalid model is
 * worse than no import at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importPlantUml, looksLikePlantUml } from '../packages/core/src/import/plantuml.ts';
import { ArchModel } from '../packages/core/src/model/model.ts';
import { emitWorkspace } from '../packages/core/src/dsl/emit.ts';
import { compile } from '../packages/core/src/dsl/compile.ts';
import { hasErrors } from '../packages/core/src/diagnostics.ts';

/** Imports, emits and recompiles — the round trip a user actually gets. */
function roundTrip(puml: string): { model: ArchModel; arch: string; stats: ReturnType<typeof importPlantUml>['stats'] } {
  const result = importPlantUml(puml, 'test.puml');
  const model = new ArchModel(result.workspace);
  const arch = emitWorkspace(model, { annotateProvenance: false });
  const recompiled = compile(arch, 'out.arch');

  if (hasErrors(recompiled.diagnostics)) {
    assert.fail(
      `imported model does not compile:\n${recompiled.diagnostics
        .map((d) => `${d.loc?.line}: ${d.message}`)
        .join('\n')}\n---\n${arch}`,
    );
  }
  return { model, arch, stats: result.stats };
}

// ------------------------------------------------------------------ detection

test('PlantUML is recognised, .arch is not mistaken for it', () => {
  assert.equal(looksLikePlantUml('@startuml\nPerson(a, "A")\n@enduml'), true);
  assert.equal(looksLikePlantUml('!include C4_Container.puml'), true);
  assert.equal(looksLikePlantUml('Container(api, "API", "Java")'), true);
  assert.equal(looksLikePlantUml('Rel(a, b, "calls")'), true);

  // Our own DSL must never be flagged.
  assert.equal(
    looksLikePlantUml('workspace "X" {\n  person p "P"\n  system s "S"\n  p -> s "uses"\n}'),
    false,
  );
  assert.equal(looksLikePlantUml(''), false);
  assert.equal(looksLikePlantUml('# just a comment\n'), false);
});

// --------------------------------------------------------------------- import

const FULL = `@startuml
!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml

title Acme Platform
' a comment that must be ignored
' another one with punctuation: /doc/overview/ + (parentheses) — dashes
AddElementTag("internal", $bgColor="#0891B2")
LAYOUT_TOP_DOWN()

Person(shopper, "Shopper", "Buys things")
Person_Ext(admin, "Administrator", "Operates the platform")

System_Boundary(acme, "Acme Platform") {
  Container(web, "Web storefront", "TypeScript / Next.js", "Customer facing", $tags="internal")
  ContainerApi(api, "Orders API", "Java 21 / Spring Boot", "Order lifecycle")
  ContainerDb(db, "Orders DB", "PostgreSQL 16", "Stores orders")
  ContainerQueue(bus, "order.events", "Apache Kafka")
}

System_Ext(idp, "Identity Provider", "Federated identity")

Rel(shopper, web, "Shops", "HTTPS")
Rel(web, api, "Calls", "HTTPS/JSON")
Rel(api, db, "Reads and writes", "JDBC")
Rel(api, bus, "Publishes", "Kafka", $tags="async")
BiRel(api, idp, "Validates tokens", "OIDC")
Rel_Back(admin, api, "Administers", "HTTPS")

SHOW_LEGEND()
@enduml
`;

test('a full C4-PlantUML container diagram imports cleanly', () => {
  const { model, stats } = roundTrip(FULL);

  assert.equal(stats.skipped, 0, 'every meaningful line should be understood');
  assert.equal(stats.elements, 8);
  assert.equal(stats.relationships, 6);

  assert.ok(model.element('shopper'));
  assert.equal(model.requireElement('shopper').kind, 'person');
  assert.ok(model.requireElement('admin').tags.includes('external'));

  const acme = model.element('acme');
  assert.ok(acme, 'the boundary becomes a system');
  assert.equal(acme.kind, 'system');

  const api = model.element('acme.api');
  assert.ok(api, 'containers nest inside the boundary');
  assert.equal(api.kind, 'container');
  assert.equal(api.subtype, 'api');
  assert.equal(api.technology, 'Java 21 / Spring Boot');
  assert.equal(api.description, 'Order lifecycle');

  assert.equal(model.requireElement('acme.db').subtype, 'database');
  assert.equal(model.requireElement('acme.bus').subtype, 'queue');
  assert.ok(model.requireElement('idp').tags.includes('external'));
});

test('the title becomes the workspace name and directives are dropped', () => {
  const { model } = roundTrip(FULL);
  assert.equal(model.workspace.name, 'Acme Platform');
  // Nothing from !include, AddElementTag, LAYOUT_* or SHOW_LEGEND may survive.
  assert.equal(
    model.elements.some((element) => /include|LAYOUT|LEGEND|AddElementTag/i.test(element.name)),
    false,
  );
});

test('relationship direction and bidirectionality survive', () => {
  const { model } = roundTrip(FULL);

  const forward = model.relations.find(
    (relation) => relation.sourceId === 'shopper' && relation.destId === 'acme.web',
  );
  assert.ok(forward);
  assert.equal(forward.description, 'Shops');
  assert.equal(forward.technology, 'HTTPS');

  const bi = model.relations.find(
    (relation) => relation.sourceId === 'acme.api' && relation.destId === 'idp',
  );
  assert.ok(bi);
  assert.equal(bi.direction, 'bi');

  // Rel_Back(admin, api) means api -> admin.
  const back = model.relations.find(
    (relation) => relation.sourceId === 'acme.api' && relation.destId === 'admin',
  );
  assert.ok(back, 'Rel_Back reverses the arrow');
});

test('views are generated so the import is immediately viewable', () => {
  const { model } = roundTrip(FULL);
  const ids = model.views.map((view) => view.id);
  assert.ok(ids.includes('landscape'));
  assert.ok(ids.some((id) => id.endsWith('-containers')));
  for (const view of model.views) {
    assert.ok(view.scopeId === undefined || model.has(view.scopeId), 'view scopes must resolve');
  }
});

// ------------------------------------------------------------ structure repair

test('a container with no boundary gets a system, and it is reported', () => {
  const result = importPlantUml(
    `@startuml
Container(api, "API", "Java")
ContainerDb(db, "DB", "PostgreSQL")
Rel(api, db, "reads")
@enduml`,
    'flat.puml',
  );

  assert.ok(result.stats.synthesized >= 1, 'a wrapping system must be invented');
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === 'import/synthesized-parent'),
    'and reported, not done silently',
  );

  const model = new ArchModel(result.workspace);
  const api = model.elements.find((element) => element.name === 'API');
  assert.ok(api);
  assert.equal(api.kind, 'container');
  assert.ok(api.parentId, 'it has a parent');
  assert.equal(model.requireElement(api.parentId).kind, 'system');
  assert.ok(api.tags.includes('imported'));

  // And the whole thing still compiles.
  const arch = emitWorkspace(model, { annotateProvenance: false });
  assert.equal(hasErrors(compile(arch, 'x.arch').diagnostics), false);
});

test('a component declared inside a system gets an intermediate container', () => {
  const { model } = roundTrip(`@startuml
System_Boundary(s, "System") {
  Component(c, "Handler", "Spring Web")
}
@enduml`);

  const component = model.elements.find((element) => element.name === 'Handler');
  assert.ok(component);
  assert.equal(component.kind, 'component');
  const parent = model.requireElement(component.parentId ?? '');
  assert.equal(parent.kind, 'container', 'a container was inserted between them');
  assert.ok(parent.tags.includes('synthesized'));
});

test('deployment nodes nest and infrastructure nodes get a host', () => {
  const { model } = roundTrip(`@startuml
Deployment_Node(aws, "AWS", "eu-central-1") {
  Deployment_Node(eks, "EKS", "Kubernetes") {
    Container(api, "API", "Java")
  }
  Infrastructure_Node(rds, "RDS", "PostgreSQL")
}
@enduml`);

  assert.equal(model.requireElement('aws').kind, 'deploymentNode');
  assert.equal(model.requireElement('aws.eks').kind, 'deploymentNode');
  assert.equal(model.requireElement('aws.rds').kind, 'infrastructureNode');
  assert.equal(model.requireElement('aws.rds').technology, 'PostgreSQL');
});

// ----------------------------------------------------------------- robustness

test('argument parsing survives commas, quotes and named arguments', () => {
  const { model } = roundTrip(`@startuml
System_Boundary(s, "S") {
  Container(a, "Reporting, Billing and Tax", "Java, Spring", "Handles A, B and C", $tags="x+y", $link="https://e.com/a,b")
}
@enduml`);

  const element = model.requireElement('s.a');
  assert.equal(element.name, 'Reporting, Billing and Tax');
  assert.equal(element.technology, 'Java, Spring');
  assert.equal(element.description, 'Handles A, B and C');
});

test('line breaks in labels are flattened rather than breaking the model', () => {
  const { model } = roundTrip(`@startuml
System(s, "Line\\nBroken", "Also\\nbroken")
@enduml`);
  assert.equal(model.requireElement('s').name, 'Line Broken');
  assert.equal(model.requireElement('s').description, 'Also broken');
});

test('relationships to undeclared aliases are reported, not invented', () => {
  const result = importPlantUml(
    `@startuml
System(a, "A")
Rel(a, ghost, "calls")
@enduml`,
    'ghost.puml',
  );
  assert.equal(result.stats.relationships, 0);
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === 'import/unknown-endpoint'),
  );
});

test('unknown macros are counted and reported', () => {
  const result = importPlantUml(
    `@startuml
System(a, "A")
Mystery_Element(b, "B")
@enduml`,
    'unknown.puml',
  );
  assert.ok(result.stats.skipped >= 1);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'import/unknown-macro'));
});

test('an empty or non-C4 file reports that nothing was found', () => {
  const result = importPlantUml('@startuml\nBob->Alice: hello\n@enduml', 'seq.puml');
  assert.equal(result.stats.elements, 0);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'import/nothing-found'));
});

test('duplicate aliases do not collide into one element', () => {
  const { model } = roundTrip(`@startuml
System_Boundary(s1, "One") {
  Container(api, "API One", "Java")
}
System_Boundary(s2, "Two") {
  Container(api2, "API Two", "Go")
}
@enduml`);
  assert.ok(model.element('s1.api'));
  assert.ok(model.element('s2.api2'));
  assert.equal(model.requireElement('s1.api').name, 'API One');
  assert.equal(model.requireElement('s2.api2').name, 'API Two');
});

test('our own exported PlantUML can be imported back', () => {
  // The exporter and importer should meet in the middle: a diagram produced by
  // `arch render --format puml` in c4 mode should be readable again.
  const exported = `@startuml
!include assets/plantuml/Arch_Container.puml

Person(customer, "Customer", "Buys")
System_Boundary(payments, "Payments") {
  ContainerApi(api, "Payment API", "Java 21", "Authorises")
  ContainerDb(db, "Payments DB", "PostgreSQL 16", "Stores")
}
Rel(customer, api, "Pays", "HTTPS")
Rel(api, db, "Reads and writes", "JDBC")
@enduml`;

  const { model, stats } = roundTrip(exported);
  assert.equal(stats.skipped, 0);
  assert.equal(model.elements.length, 4);
  assert.equal(model.relations.length, 2);
  assert.equal(model.requireElement('payments.api').technology, 'Java 21');
});
