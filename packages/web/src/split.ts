/**
 * Archforge split view: code left, diagram right.
 *
 * A deliberately smaller surface than the full editor. There is no palette, no
 * explorer and no inspector, because this view is for the person who *writes*
 * the model and wants the biggest possible picture of what they just typed. The
 * trade is made once, here, rather than being a mode inside the main editor
 * that half the controls would have to know about.
 *
 * It shares the engine and the editor primitives with the full app, so the two
 * cannot disagree about what a model means or how it looks.
 */

import {
  ArchModel,
  canonicalJson,
  check,
  compileFiles,
  deriveAll,
  documentWorkspace,
  emitWorkspace,
  formatLoc,
  hasErrors,
  layout,
  renderSvg,
  sortDiagnostics,
  toMermaid,
  toPlantUml,
  type DerivedView,
  type Diagnostic,
  type Violation,
} from '../../core/src/index.ts';
import {
  capturePointer,
  download,
  escapeHtml,
  gutterHtml,
  highlightSource,
  releasePointer,
  TEMPLATE,
} from './shared.ts';

interface Pins {
  [viewId: string]: { [elementId: string]: { x: number; y: number } };
}

const STORAGE = {
  source: 'archforge.source',
  theme: 'archforge.theme',
  view: 'archforge.split.view',
  width: 'archforge.split.width',
} as const;

const state = {
  source: '',
  model: undefined as ArchModel | undefined,
  views: [] as DerivedView[],
  diagnostics: [] as readonly Diagnostic[],
  violations: [] as readonly Violation[],
  activeViewId: undefined as string | undefined,
  selectedId: undefined as string | undefined,
  zoom: 1,
  panX: 0,
  panY: 0,
  direction: 'TB' as 'TB' | 'LR',
  pins: {} as Pins,
  undo: [] as string[],
  redo: [] as string[],
};

// -------------------------------------------------------------------- helpers

function el<T extends HTMLElement>(binding: string): T {
  const node = document.querySelector<T>(`[data-bind="${binding}"]`);
  if (!node) throw new Error(`missing element: ${binding}`);
  return node;
}

let statusTimer = 0;
function setStatus(message: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  const node = el('status');
  node.textContent = message;
  node.className = `status${kind === 'error' ? ' is-error' : kind === 'success' ? ' is-success' : ''}`;
  window.clearTimeout(statusTimer);
  if (message !== '') {
    statusTimer = window.setTimeout(() => {
      node.textContent = '';
      node.className = 'status';
    }, 4000);
  }
}

function activeView(): DerivedView | undefined {
  return state.views.find((view) => view.id === state.activeViewId);
}

// ------------------------------------------------------------------- pipeline

let compileTimer = 0;

function scheduleCompile(): void {
  window.clearTimeout(compileTimer);
  compileTimer = window.setTimeout(recompile, 140);
}

function recompile(): void {
  const result = compileFiles([{ file: 'architecture.arch', text: state.source }]);
  state.diagnostics = result.diagnostics;

  if (!hasErrors(result.diagnostics)) {
    const model = new ArchModel(result.workspace);
    state.model = model;
    state.views = deriveAll(model);
    state.violations = check(model).violations;
    if (!state.activeViewId || !state.views.some((view) => view.id === state.activeViewId)) {
      state.activeViewId = state.views[0]?.id;
    }
  } else {
    // Keep the last good diagram on screen rather than blanking it on every
    // half-typed line; the problem strip says what is wrong.
    state.violations = [];
  }

  localStorage.setItem(STORAGE.source, state.source);
  renderTabs();
  renderCanvas();
  renderProblems();
  renderHighlight();
  renderSecondaryView();
}

function renderHighlight(): void {
  el('highlight').innerHTML = highlightSource(state.source);
  const errorLines = new Set(
    state.diagnostics
      .filter((diagnostic) => diagnostic.severity === 'error')
      .map((diagnostic) => diagnostic.loc?.line ?? -1),
  );
  el('gutter').innerHTML = gutterHtml(state.source, errorLines);
  el('gutter').scrollTop = el('code-scroll').scrollTop;
}

// ------------------------------------------------------------------- problems

function renderProblems(): void {
  const sorted = sortDiagnostics(state.diagnostics);
  const errors = sorted.filter((diagnostic) => diagnostic.severity === 'error').length;

  const problemBadge = el('problem-count');
  problemBadge.textContent = `${sorted.length} problem${sorted.length === 1 ? '' : 's'}`;
  problemBadge.className = `badge${errors > 0 ? ' is-error' : ''}`;

  const warnings = state.violations.filter((violation) => violation.severity === 'warning').length;
  const ruleErrors = state.violations.filter((violation) => violation.severity === 'error').length;
  const checkBadge = el('violation-count');
  checkBadge.textContent = `${state.violations.length} check${state.violations.length === 1 ? '' : 's'}`;
  checkBadge.className = `badge${ruleErrors > 0 ? ' is-error' : warnings > 0 ? ' is-warning' : ''}`;

  // Compile errors first, then rule violations, in one strip.
  const rows: string[] = [];
  for (const diagnostic of sorted) {
    rows.push(
      `<div class="split-problem is-${diagnostic.severity}" data-line="${diagnostic.loc?.line ?? ''}">` +
        `<span class="split-problem-icon">${
          diagnostic.severity === 'error' ? '✗' : diagnostic.severity === 'warning' ? '⚠' : 'i'
        }</span>` +
        `<span>${escapeHtml(diagnostic.message)}` +
        (diagnostic.loc
          ? `<span class="split-problem-loc">${escapeHtml(formatLoc(diagnostic.loc))}</span>`
          : '') +
        `</span></div>`,
    );
  }
  for (const violation of state.violations) {
    rows.push(
      `<div class="split-problem is-${violation.severity}" data-line="${violation.loc?.line ?? ''}">` +
        `<span class="split-problem-icon">${
          violation.severity === 'error' ? '✗' : violation.severity === 'warning' ? '⚠' : 'i'
        }</span>` +
        `<span>${escapeHtml(violation.message)}` +
        `<span class="split-problem-loc">${escapeHtml(violation.ruleId)}</span>` +
        `</span></div>`,
    );
  }

  const strip = el('problems-strip');
  strip.innerHTML = rows.join('');
  for (const row of strip.querySelectorAll<HTMLElement>('[data-line]')) {
    row.addEventListener('click', () => {
      const line = Number(row.getAttribute('data-line'));
      if (Number.isFinite(line) && line > 0) jumpToLine(line);
    });
  }
}

function jumpToLine(line: number): void {
  const textarea = el<HTMLTextAreaElement>('code');
  const lines = state.source.split('\n');
  let offset = 0;
  for (let i = 0; i < line - 1; i += 1) offset += (lines[i]?.length ?? 0) + 1;
  textarea.focus();
  textarea.setSelectionRange(offset, offset + (lines[line - 1]?.length ?? 0));
  el('code-scroll').scrollTop = Math.max(0, (line - 4) * 19);
}

// --------------------------------------------------------------------- canvas

function renderTabs(): void {
  const tabs = el('tabs');
  tabs.innerHTML = '';
  for (const view of state.views) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `view-tab${view.id === state.activeViewId ? ' is-active' : ''}`;
    button.innerHTML = `${escapeHtml(view.title)}<span class="kind">${escapeHtml(view.kind)}</span>`;
    button.addEventListener('click', () => {
      state.activeViewId = view.id;
      localStorage.setItem(STORAGE.view, view.id);
      renderTabs();
      renderCanvas();
      renderSecondaryView();
      fitToViewport();
    });
    tabs.appendChild(button);
    if (view.id === state.activeViewId) {
      window.setTimeout(() => button.scrollIntoView({ block: 'nearest', inline: 'nearest' }), 0);
    }
  }
}

function renderCanvas(): void {
  const viewport = el('viewport');
  const hint = el('hint');
  const view = activeView();

  if (!state.model || !view) {
    viewport.innerHTML = '';
    hint.textContent = hasErrors(state.diagnostics)
      ? 'The model does not compile yet — see the problems on the left.'
      : 'No views defined. Add a `views { ... }` block.';
    return;
  }
  hint.textContent = '';

  viewport.innerHTML = renderSvg(
    view,
    layout(view, { direction: state.direction, overrides: state.pins[view.id] ?? {} }),
    {
      theme: (document.documentElement.dataset['theme'] as 'light' | 'dark') ?? 'light',
      interactive: true,
      showTitle: false,
      showBackground: false,
      workspaceName: state.model.workspace.name,
    },
  );

  applyTransform();
  for (const node of viewport.querySelectorAll('[data-arch-id]')) {
    node.classList.toggle('is-selected', node.getAttribute('data-arch-id') === state.selectedId);
  }
  wireCanvas();
}

function applyTransform(): void {
  el('viewport').style.transform =
    `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  el('zoom').textContent = `${Math.round(state.zoom * 100)}%`;
}

let fitPending = false;

function fitToViewport(attempt = 0): void {
  if (fitPending && attempt === 0) return;
  fitPending = true;

  requestAnimationFrame(() => {
    fitPending = false;
    const svg = el('viewport').querySelector('svg');
    if (!svg) return;
    const canvas = el('canvas');
    const width = Number(svg.getAttribute('width') ?? 0);
    const height = Number(svg.getAttribute('height') ?? 0);
    if (width === 0 || height === 0) return;
    if (canvas.clientWidth < 80 || canvas.clientHeight < 80) {
      if (attempt < 5) fitToViewport(attempt + 1);
      return;
    }
    const padding = 28;
    state.zoom = Math.max(
      0.08,
      Math.min(
        (canvas.clientWidth - padding * 2) / width,
        (canvas.clientHeight - padding * 2) / height,
        2.2,
      ),
    );
    state.panX = Math.round((canvas.clientWidth - width * state.zoom) / 2);
    state.panY = Math.round(Math.max(padding, (canvas.clientHeight - height * state.zoom) / 2));
    applyTransform();
  });
}

let canvasWired = false;

function wireCanvas(): void {
  if (canvasWired) return;
  canvasWired = true;
  const canvas = el('canvas');

  canvas.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const next = Math.min(4, Math.max(0.08, state.zoom * Math.exp(-event.deltaY * 0.0016)));
      const ratio = next / state.zoom;
      state.panX = pointerX - (pointerX - state.panX) * ratio;
      state.panY = pointerY - (pointerY - state.panY) * ratio;
      state.zoom = next;
      applyTransform();
    },
    { passive: false },
  );

  canvas.addEventListener('pointerdown', (event: PointerEvent) => {
    const target = event.target as HTMLElement | null;
    const group = target?.closest('[data-arch-id]');
    const id = group?.getAttribute('data-arch-id') ?? undefined;

    if (id) {
      state.selectedId = id;
      for (const node of canvas.querySelectorAll('[data-arch-id]')) {
        node.classList.toggle('is-selected', node.getAttribute('data-arch-id') === id);
      }
      // Double-click jumps to the declaration; single click just selects.
      return;
    }

    const startX = event.clientX - state.panX;
    const startY = event.clientY - state.panY;
    canvas.classList.add('is-panning');
    capturePointer(canvas, event.pointerId);

    const onMove = (move: PointerEvent): void => {
      state.panX = move.clientX - startX;
      state.panY = move.clientY - startY;
      applyTransform();
    };
    const onUp = (): void => {
      releasePointer(canvas, event.pointerId);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.classList.remove('is-panning');
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
  });

  canvas.addEventListener('dblclick', (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    const id = target?.closest('[data-arch-id]')?.getAttribute('data-arch-id');
    const element = id ? state.model?.element(id) : undefined;
    if (element?.provenance.source === 'declared' && element.provenance.loc) {
      jumpToLine(element.provenance.loc.line);
      setStatus(`${element.name} — ${formatLoc(element.provenance.loc)}`);
    }
  });
}

// ------------------------------------------------------- secondary code view

function renderSecondaryView(): void {
  const mode = el<HTMLSelectElement>('source-view').value;
  const editor = document.querySelector<HTMLElement>('.split-editor');
  const generated = el('generated');
  if (!editor) return;

  if (mode === 'source') {
    editor.hidden = false;
    generated.hidden = true;
    return;
  }

  editor.hidden = true;
  generated.hidden = false;

  const model = state.model;
  const view = activeView();
  if (!model) {
    generated.textContent = 'The model does not compile yet.';
    return;
  }
  if (mode === 'json') {
    generated.textContent = canonicalJson(model.workspace);
    return;
  }
  if (!view) {
    generated.textContent = 'No view selected.';
    return;
  }
  generated.textContent =
    mode === 'mermaid'
      ? toMermaid(view, { direction: state.direction })
      : toPlantUml(model, view, { direction: state.direction });
}

// --------------------------------------------------------------------- edits

function setSource(text: string, note?: string): void {
  state.undo.push(state.source);
  state.redo = [];
  state.source = text;
  el<HTMLTextAreaElement>('code').value = text;
  state.pins = {};
  recompile();
  if (note) setStatus(note, 'success');
  fitToViewport();
}

function undo(): void {
  const previous = state.undo.pop();
  if (previous === undefined) return setStatus('Nothing to undo.');
  state.redo.push(state.source);
  state.source = previous;
  el<HTMLTextAreaElement>('code').value = previous;
  recompile();
}

function redo(): void {
  const next = state.redo.pop();
  if (next === undefined) return setStatus('Nothing to redo.');
  state.undo.push(state.source);
  state.source = next;
  el<HTMLTextAreaElement>('code').value = next;
  recompile();
}

// ------------------------------------------------------------------- exports

function currentSvg(): string {
  const model = state.model;
  const view = activeView();
  if (!model || !view) return '';
  return renderSvg(
    view,
    layout(view, { direction: state.direction, overrides: state.pins[view.id] ?? {} }),
    { theme: 'light', workspaceName: model.workspace.name, showLegend: true },
  );
}

function exportAs(format: string): void {
  const model = state.model;
  if (!model) return setStatus('Nothing to export — the model does not compile.', 'error');
  const view = activeView();
  const base = (model.workspace.name || 'architecture').toLowerCase().replace(/[^a-z0-9]+/g, '-');

  switch (format) {
    case 'arch':
      download(`${base}.arch`, state.source);
      break;
    case 'json':
      download(`${base}.json`, canonicalJson(model.workspace), 'application/json');
      break;
    case 'md':
      download(`${base}.md`, documentWorkspace(model, state.views, {}), 'text/markdown');
      break;
    case 'svg':
      if (view) download(`${view.id}.svg`, currentSvg(), 'image/svg+xml');
      break;
    case 'puml':
      if (view) download(`${view.id}.puml`, toPlantUml(model, view, { direction: state.direction }));
      break;
    case 'mermaid':
      if (view) download(`${view.id}.mmd`, toMermaid(view, { direction: state.direction }));
      break;
    case 'png':
      if (view) void exportPng(view.id);
      break;
    default:
      return;
  }
  setStatus('Exported.', 'success');
}

async function exportPng(name: string): Promise<void> {
  const svg = currentSvg();
  const match = /width="(\d+)" height="(\d+)"/.exec(svg);
  const width = Number(match?.[1] ?? 1200);
  const height = Number(match?.[2] ?? 800);
  const scale = 2;

  const image = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('could not rasterise the diagram'));
    image.src = url;
  });

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(scale, scale);
  context.drawImage(image, 0, 0);
  URL.revokeObjectURL(url);

  canvas.toBlob((blob) => {
    if (!blob) return;
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${name}.png`;
    anchor.click();
  }, 'image/png');
}

function importFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result ?? '');
    if (file.name.endsWith('.json')) {
      try {
        const workspace = JSON.parse(text) as Parameters<typeof ArchModel.of>[0];
        setSource(emitWorkspace(ArchModel.of(workspace)), `Imported ${file.name} as DSL.`);
      } catch {
        setStatus('That JSON is not an Archforge model.', 'error');
      }
      return;
    }
    setSource(text, `Imported ${file.name}.`);
  };
  reader.readAsText(file);
}

// ---------------------------------------------------------------------- boot

function wire(): void {
  const textarea = el<HTMLTextAreaElement>('code');
  textarea.addEventListener('input', () => {
    state.source = textarea.value;
    scheduleCompile();
  });
  textarea.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = `${textarea.value.slice(0, start)}  ${textarea.value.slice(end)}`;
      textarea.selectionStart = textarea.selectionEnd = start + 2;
      state.source = textarea.value;
      scheduleCompile();
    }
  });
  el('code-scroll').addEventListener('scroll', () => {
    el('gutter').scrollTop = el('code-scroll').scrollTop;
  });

  el<HTMLSelectElement>('source-view').addEventListener('change', renderSecondaryView);

  const actions: Record<string, () => void> = {
    new: () => setSource(TEMPLATE, 'New model from template.'),
    example: () => {
      void fetch('../examples/globex-commerce.arch')
        .then((response) => (response.ok ? response.text() : Promise.reject(new Error('missing'))))
        .then((text) => setSource(text, 'Loaded Globex Commerce — 107 elements.'))
        .catch(() => setStatus('Example not available in this build.', 'error'));
    },
    import: () => el<HTMLInputElement>('file-input').click(),
    undo,
    redo,
    fit: () => fitToViewport(),
    direction: () => {
      state.direction = state.direction === 'TB' ? 'LR' : 'TB';
      el('direction').textContent = state.direction;
      renderCanvas();
      renderSecondaryView();
      fitToViewport();
    },
    theme: () => {
      const next = document.documentElement.dataset['theme'] === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset['theme'] = next;
      localStorage.setItem(STORAGE.theme, next);
      renderCanvas();
    },
    'zoom-in': () => {
      state.zoom = Math.min(4, state.zoom * 1.2);
      applyTransform();
    },
    'zoom-out': () => {
      state.zoom = Math.max(0.08, state.zoom / 1.2);
      applyTransform();
    },
    'reset-pins': () => {
      const view = activeView();
      if (!view) return;
      delete state.pins[view.id];
      renderCanvas();
      fitToViewport();
      setStatus('Manual positions cleared.');
    },
  };

  for (const [action, handler] of Object.entries(actions)) {
    for (const node of document.querySelectorAll(`[data-action="${action}"]`)) {
      node.addEventListener('click', handler);
    }
  }

  const exportSelect = document.querySelector<HTMLSelectElement>('[data-action="export"]');
  exportSelect?.addEventListener('change', () => {
    const format = exportSelect.value;
    exportSelect.value = '';
    if (format) exportAs(format);
  });

  el<HTMLInputElement>('file-input').addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) importFile(file);
  });

  // ---- vertical divider
  const divider = el('split-divider');
  divider.addEventListener('pointerdown', (event: PointerEvent) => {
    event.preventDefault();
    divider.classList.add('is-dragging');
    capturePointer(divider, event.pointerId);

    const onMove = (move: PointerEvent): void => {
      // Clamp so neither pane can be dragged out of existence.
      const percent = Math.min(Math.max((move.clientX / window.innerWidth) * 100, 12), 70);
      document.documentElement.style.setProperty('--code-w', `${percent.toFixed(2)}%`);
    };
    const onUp = (): void => {
      releasePointer(divider, event.pointerId);
      divider.removeEventListener('pointermove', onMove);
      divider.removeEventListener('pointerup', onUp);
      divider.classList.remove('is-dragging');
      localStorage.setItem(
        STORAGE.width,
        document.documentElement.style.getPropertyValue('--code-w'),
      );
      fitToViewport();
    };
    divider.addEventListener('pointermove', onMove);
    divider.addEventListener('pointerup', onUp);
  });
  divider.addEventListener('dblclick', () => {
    document.documentElement.style.setProperty('--code-w', '25%');
    localStorage.setItem(STORAGE.width, '25%');
    fitToViewport();
  });

  window.addEventListener('keydown', (event: KeyboardEvent) => {
    const typing =
      document.activeElement === textarea || document.activeElement instanceof HTMLInputElement;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      exportAs('arch');
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      if (document.activeElement === textarea) return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (typing) return;
    if (event.key === 'f') fitToViewport();
    if (event.key === '+' || event.key === '=') actions['zoom-in']?.();
    if (event.key === '-') actions['zoom-out']?.();
  });

  window.addEventListener('resize', () => applyTransform());
}

function boot(): void {
  const theme = localStorage.getItem(STORAGE.theme);
  if (theme) document.documentElement.dataset['theme'] = theme;
  const width = localStorage.getItem(STORAGE.width);
  if (width) document.documentElement.style.setProperty('--code-w', width);

  state.activeViewId = localStorage.getItem(STORAGE.view) ?? undefined;
  state.source = localStorage.getItem(STORAGE.source) ?? TEMPLATE;
  el<HTMLTextAreaElement>('code').value = state.source;
  el('direction').textContent = state.direction;

  wire();
  recompile();
  fitToViewport();
}

boot();
