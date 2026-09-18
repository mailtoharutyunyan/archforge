/**
 * Documentation generation.
 *
 * Architecture documentation is always generated, never authored, so it cannot
 * drift from the model. The output is plain Markdown with embedded SVG links,
 * which renders on GitHub, in a wiki, in a static site, and converts to PDF.
 */

import type { ArchModel } from '../model/model.ts';
import type { Element } from '../model/types.ts';
import { compareIds } from '../util/canonical.ts';
import type { DerivedView } from '../views/views.ts';

export interface DocsOptions {
  /** Relative directory the rendered diagrams were written to. */
  readonly diagramDir?: string;
  readonly includeInventories?: boolean;
}

export function documentWorkspace(
  model: ArchModel,
  views: readonly DerivedView[],
  options: DocsOptions = {},
): string {
  const diagramDir = options.diagramDir ?? 'diagrams';
  const includeInventories = options.includeInventories ?? true;
  const lines: string[] = [];

  lines.push(`# ${model.workspace.name}`);
  lines.push('');
  if (model.workspace.description) {
    lines.push(model.workspace.description);
    lines.push('');
  }
  lines.push(
    '> Generated from the architecture model. Edit the `.arch` sources, not this file.',
  );
  lines.push('');

  // Contents
  lines.push('## Contents');
  lines.push('');
  lines.push('- [Overview](#overview)');
  for (const view of views) lines.push(`- [${view.title}](#${anchor(view.title)})`);
  if (includeInventories) {
    lines.push('- [Technology inventory](#technology-inventory)');
    lines.push('- [Ownership](#ownership)');
    lines.push('- [Dependencies](#dependencies)');
  }
  lines.push('');

  // Overview
  lines.push('## Overview');
  lines.push('');
  lines.push('| Kind | Count |');
  lines.push('| --- | --- |');
  const counts = new Map<string, number>();
  for (const element of model.elements) {
    counts.set(element.kind, (counts.get(element.kind) ?? 0) + 1);
  }
  for (const [kind, count] of [...counts].sort((a, b) => compareIds(a[0], b[0]))) {
    lines.push(`| ${kind} | ${count} |`);
  }
  lines.push(`| relationships | ${model.relations.length} |`);
  lines.push('');

  // One section per view, each with its diagram and a table of its elements.
  for (const view of views) {
    lines.push(`## ${view.title}`);
    lines.push('');
    lines.push(`*${view.kind} view${view.scopeId ? ` of \`${view.scopeId}\`` : ''}*`);
    lines.push('');
    lines.push(`![${escapeMd(view.title)}](${diagramDir}/${view.id}.svg)`);
    lines.push('');

    if (view.kind === 'dynamic') {
      lines.push('| # | From | To | Description |');
      lines.push('| --- | --- | --- | --- |');
      for (const edge of view.edges) {
        lines.push(
          `| ${edge.order ?? ''} | ${name(model, edge.sourceId)} | ${name(model, edge.destId)} | ${escapeMd(
            edge.description ?? '',
          )} |`,
        );
      }
      lines.push('');
      continue;
    }

    lines.push('| Element | Type | Technology | Owner | Description |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const node of view.nodes) {
      const element = node.element;
      lines.push(
        `| **${escapeMd(element.name)}** | ${element.subtype ?? element.kind} | ${escapeMd(
          element.technology ?? '—',
        )} | ${escapeMd(element.owner ?? '—')} | ${escapeMd(element.description ?? '')} |`,
      );
    }
    lines.push('');
  }

  if (!includeInventories) return `${lines.join('\n')}\n`;

  // Technology inventory: the question "what are we running?" answered from
  // the model rather than from a spreadsheet that is six months out of date.
  lines.push('## Technology inventory');
  lines.push('');
  const technologies = new Map<string, Element[]>();
  for (const element of model.elements) {
    if (!element.technology) continue;
    const users = technologies.get(element.technology) ?? [];
    users.push(element);
    technologies.set(element.technology, users);
  }
  lines.push('| Technology | Used by |');
  lines.push('| --- | --- |');
  for (const [technology, users] of [...technologies].sort((a, b) => compareIds(a[0], b[0]))) {
    lines.push(
      `| ${escapeMd(technology)} | ${users
        .map((user) => escapeMd(user.name))
        .sort(compareIds)
        .join(', ')} |`,
    );
  }
  lines.push('');

  lines.push('## Ownership');
  lines.push('');
  const owners = new Map<string, Element[]>();
  for (const element of model.elements) {
    if (element.kind !== 'container' && element.kind !== 'system') continue;
    const key = element.owner ?? '(unowned)';
    const owned = owners.get(key) ?? [];
    owned.push(element);
    owners.set(key, owned);
  }
  lines.push('| Owner | Systems and containers |');
  lines.push('| --- | --- |');
  for (const [owner, owned] of [...owners].sort((a, b) => compareIds(a[0], b[0]))) {
    lines.push(
      `| ${escapeMd(owner)} | ${owned.map((e) => escapeMd(e.name)).sort(compareIds).join(', ')} |`,
    );
  }
  lines.push('');

  lines.push('## Dependencies');
  lines.push('');
  lines.push('| From | To | Description | Technology |');
  lines.push('| --- | --- | --- | --- |');
  for (const relation of model.relations) {
    lines.push(
      `| ${name(model, relation.sourceId)} | ${name(model, relation.destId)} | ${escapeMd(
        relation.description ?? '',
      )} | ${escapeMd(relation.technology ?? '—')} |`,
    );
  }
  lines.push('');

  // Inferred facts are listed separately and labelled, never mixed in.
  const inferred = model.elements.filter((element) => element.provenance.source === 'inferred');
  if (inferred.length > 0) {
    lines.push('## Inferred from source code');
    lines.push('');
    lines.push(
      'These elements were detected by scanning a repository and have **not** been confirmed by a human.',
    );
    lines.push('');
    lines.push('| Element | Detector | Confidence | Evidence |');
    lines.push('| --- | --- | --- | --- |');
    for (const element of inferred) {
      if (element.provenance.source !== 'inferred') continue;
      const evidence = element.provenance.evidence
        .slice(0, 2)
        .map((item) => `\`${item.file}:${item.line}\``)
        .join(', ');
      lines.push(
        `| ${escapeMd(element.name)} | ${element.provenance.detector} | ${element.provenance.confidence} | ${evidence} |`,
      );
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function name(model: ArchModel, id: string): string {
  return escapeMd(model.element(id)?.name ?? id);
}

function escapeMd(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function anchor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}
