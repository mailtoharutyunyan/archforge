/**
 * Archforge web editor.
 *
 * A static, zero-backend application: it imports the same engine the CLI uses,
 * so the browser and CI can never disagree about what a model means. There is
 * no server, so nothing you open here is uploaded anywhere — including source
 * folders you analyse, which are read through the File API in this tab.
 *
 * Interaction model, deliberately: the canvas is fully direct-manipulable, but
 * shapes come from the model rather than from a shape palette. Dragging a node
 * pins its position into a layout file; it never edits the architecture. The
 * text is the architecture.
 */

import {
  ArchModel,
  canonicalJson,
  importPlantUml,
  looksLikePlantUml,
  check,
  compileFiles,
  deriveAll,
  documentWorkspace,
  formatLoc,
  hasErrors,
  layout,
  lex,
  renderSvg,
  sortDiagnostics,
  toMermaid,
  toPlantUml,
  type DerivedView,
  type Diagnostic,
  type Element,
  type Violation,
} from '../../core/src/index.ts';
import { emitWorkspace } from '../../core/src/dsl/emit.ts';
import {
  addElement,
  addRelationship,
  removeElement,
  renameIdentifier,
  setElementProperty,
  type EditResult,
} from '../../core/src/dsl/edit.ts';
import {
  paletteByGroup,
  paletteEntry,
  searchPalette,
  type PaletteEntry,
} from '../../core/src/catalog.ts';
import { resolveIcon } from '../../core/src/render/icons.ts';
import { scanRepository } from '../../core/src/scan/registry.ts';
import { fileSourceFromFileList } from '../../core/src/scan/source.ts';
import { synthesizeWorkspace } from '../../core/src/scan/synthesize.ts';

// ---------------------------------------------------------------------- state

interface Pins {
  [viewId: string]: { [elementId: string]: { x: number; y: number } };
}

/**
 * Pins are stored per view id, and view ids are generic ("landscape",
 * "containers"). Loading a different model that happens to reuse a view name
 * would otherwise apply the previous model's coordinates to it, scattering
 * unrelated elements across the canvas. Stamping the stored pins with a
 * signature of the model's element ids makes that impossible: a mismatch
 * discards them instead of drawing something wrong.
 */
function modelSignature(model: ArchModel | undefined): string {
  if (!model) return '';
  return `${model.workspace.name}|${model.elements.length}|${model.elements
    .map((element) => element.id)
    .join(',')}`
    .split('')
    .reduce((hash, character) => ((hash << 5) - hash + character.charCodeAt(0)) | 0, 0)
    .toString(36);
}

interface State {
  source: string;
  model?: ArchModel;
  views: DerivedView[];
  diagnostics: readonly Diagnostic[];
  violations: readonly Violation[];
  activeViewId?: string;
  selectedId?: string;
  zoom: number;
  panX: number;
  panY: number;
  direction: 'TB' | 'LR';
  pins: Pins;
  filter: string;
  side: 'palette' | 'model';
  /** Source snapshots. Undo is a string swap, which cannot corrupt anything. */
  undo: string[];
  redo: string[];
}

const STORAGE = {
  source: 'archforge.source',
  pins: 'archforge.pins',
  theme: 'archforge.theme',
  view: 'archforge.view',
} as const;

const state: State = {
  source: '',
  views: [],
  diagnostics: [],
  violations: [],
  zoom: 1,
  panX: 0,
  panY: 0,
  direction: 'TB',
  pins: {},
  filter: '',
  side: 'palette',
  undo: [],
  redo: [],
};

const UNDO_LIMIT = 100;

/** Pins read from storage, held until the model confirms they belong to it. */
let pendingPins: { signature?: string; pins?: Pins } = {};

function savePins(): void {
  localStorage.setItem(
    STORAGE.pins,
    JSON.stringify({ signature: modelSignature(state.model), pins: state.pins }),
  );
}

// -------------------------------------------------------------------- helpers

function el<T extends HTMLElement>(binding: string): T {
  const node = document.querySelector<T>(`[data-bind="${binding}"]`);
  if (!node) throw new Error(`missing element: ${binding}`);
  return node;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
    }, 4500);
  }
}

function download(filename: string, content: string, mime = 'text/plain'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking immediately can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ------------------------------------------------------------------- pipeline

let compileTimer = 0;

function scheduleCompile(): void {
  window.clearTimeout(compileTimer);
  // Short debounce: long enough to avoid recompiling mid-word, short enough
  // that the diagram feels like it is tracking the text.
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

    // Adopt stored pins only if they were saved against this exact model.
    if (pendingPins.signature !== undefined) {
      const signature = modelSignature(model);
      state.pins = pendingPins.signature === signature ? (pendingPins.pins ?? {}) : {};
      pendingPins = {};
    }
  } else {
    // Keep the last good model on screen: a diagram that vanishes on every
    // half-typed line is worse than a slightly stale one.
    state.violations = [];
  }

  localStorage.setItem(STORAGE.source, state.source);
  renderProblems();
  renderChecks();
  renderTabs();
  renderTree();
  renderCanvas();
  renderInspector();
  renderGenerated();
  highlight();
}

// ------------------------------------------------------------- authoring

/**
 * Applies a structural edit to the source.
 *
 * Every visual action funnels through here, which is what makes the canvas and
 * the text one editor rather than two: the canvas never holds state of its own,
 * it just rewrites the source and lets the pipeline re-derive everything.
 */
function applyEdit(result: EditResult): boolean {
  if (!result.changed) {
    setStatus(result.note, 'error');
    return false;
  }
  state.undo.push(state.source);
  if (state.undo.length > UNDO_LIMIT) state.undo.shift();
  state.redo = [];

  state.source = result.text;
  el<HTMLTextAreaElement>('code').value = result.text;
  recompile();
  setStatus(result.note, 'success');
  return true;
}

function undo(): void {
  const previous = state.undo.pop();
  if (previous === undefined) {
    setStatus('Nothing to undo.');
    return;
  }
  state.redo.push(state.source);
  state.source = previous;
  el<HTMLTextAreaElement>('code').value = previous;
  recompile();
  setStatus('Undone.');
}

function redo(): void {
  const next = state.redo.pop();
  if (next === undefined) {
    setStatus('Nothing to redo.');
    return;
  }
  state.undo.push(state.source);
  state.source = next;
  el<HTMLTextAreaElement>('code').value = next;
  recompile();
  setStatus('Redone.');
}

/**
 * Chooses the parent for a newly dropped element.
 *
 * Preference order: an explicit boundary under the cursor, then the view's own
 * scope when that scope can contain the thing being added, then the top level.
 * Dropping a container inside the system you are looking at is almost always
 * what was meant.
 */
function dropParentFor(entry: PaletteEntry, target: HTMLElement | null): string | undefined {
  const model = state.model;
  if (!model) return undefined;

  // People and systems only ever live at the top level.
  if (entry.keyword === 'person' || entry.keyword === 'system') return undefined;
  // Deployment nodes may nest, but only inside another deployment node.
  const boundary = target?.closest('.arch-boundary');
  const boundaryId = boundary?.getAttribute('data-arch-id') ?? undefined;

  const canContain = (parentId: string | undefined): boolean => {
    if (parentId === undefined) return entry.keyword === 'deploymentNode';
    const parent = model.element(parentId);
    if (!parent) return false;
    if (entry.keyword === 'deploymentNode' || entry.keyword === 'infrastructureNode') {
      return parent.kind === 'deploymentNode';
    }
    if (entry.keyword === 'component') return parent.kind === 'container';
    // Containers and the sugar keywords want a system.
    return parent.kind === 'system' || parent.kind === 'container';
  };

  if (boundaryId && canContain(boundaryId)) return boundaryId;

  const scopeId = activeView()?.scopeId;
  if (scopeId && canContain(scopeId)) return scopeId;

  // Fall back to the only system in the model, if there is exactly one: with a
  // single system there is no ambiguity about where a container belongs.
  const systems = model.byKind('system').filter((system) => !system.tags.includes('external'));
  if (systems.length === 1 && canContain(systems[0]?.id)) return systems[0]?.id;

  return undefined;
}

function addFromPalette(entry: PaletteEntry, target: HTMLElement | null): void {
  const model = state.model;
  if (!model) {
    setStatus('Fix the model before adding elements.', 'error');
    return;
  }

  const parentId = dropParentFor(entry, target);

  // A component cannot live at the top level, so say why rather than emitting
  // something that will not compile.
  if (entry.keyword === 'component' && parentId === undefined) {
    setStatus('A component must go inside a container — drop it on one.', 'error');
    return;
  }
  if (
    parentId === undefined &&
    entry.keyword !== 'person' &&
    entry.keyword !== 'system' &&
    entry.keyword !== 'deploymentNode'
  ) {
    setStatus(
      `Drop ${entry.label} onto a system to add it there, or add a system first.`,
      'error',
    );
    return;
  }

  applyEdit(
    addElement(state.source, model, {
      keyword: entry.keyword,
      name: entry.label,
      parentId,
      technology: entry.technology,
    }),
  );
}

/** Shift-click a second node to connect the selected one to it. */
function connectTo(destId: string): void {
  const model = state.model;
  const sourceId = state.selectedId;
  if (!model || !sourceId) {
    setStatus('Select the source element first, then shift-click the target.');
    return;
  }
  applyEdit(addRelationship(state.source, model, { sourceId, destId }));
}

function deleteSelected(): void {
  const model = state.model;
  if (!model || !state.selectedId) return;
  const element = model.element(state.selectedId);
  if (!element) return;
  const removed = applyEdit(removeElement(state.source, model, state.selectedId));
  if (removed) select(undefined);
}

// ------------------------------------------------------------------- palette

/**
 * The palette entry currently being dragged.
 *
 * `dataTransfer.getData()` returns an empty string during `dragover` — the
 * spec puts the drag data in "protected mode" until the drop — so the target
 * highlight cannot read the payload from the event. Keeping it here is the
 * only way to know what is being dragged while it is still in the air.
 */
let draggingEntry: PaletteEntry | undefined;

function renderPalette(): void {
  const host = el('palette');
  const entries = searchPalette(state.filter);
  host.innerHTML = '';

  if (entries.length === 0) {
    host.innerHTML = '<div class="empty">Nothing matches that search.</div>';
    return;
  }

  for (const section of paletteByGroup(entries)) {
    const heading = document.createElement('div');
    heading.className = 'palette-group';
    heading.textContent = section.group;
    host.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'palette-grid';

    for (const entry of section.entries) {
      const item = document.createElement('div');
      item.className = 'palette-item';
      item.draggable = true;
      item.dataset['entry'] = entry.id;
      item.title = entry.technology
        ? `${entry.label} — ${entry.technology}`
        : `${entry.label} (${entry.keyword})`;

      const icon = resolveIcon({
        kind: entry.keyword,
        subtype: entry.keyword,
        technology: entry.technology,
      });
      const iconHost = document.createElement('span');
      iconHost.className = 'palette-icon';
      if (icon) {
        iconHost.innerHTML =
          `<svg viewBox="${escapeHtml(icon.viewBox)}" aria-hidden="true"` +
          (icon.monochrome ? ' fill="#0f172a" color="#0f172a"' : '') +
          `>${icon.body}</svg>`;
      }
      item.appendChild(iconHost);

      const label = document.createElement('span');
      label.className = 'palette-label';
      label.textContent = entry.label;
      item.appendChild(label);

      item.addEventListener('dragstart', (event: DragEvent) => {
        draggingEntry = entry;
        event.dataTransfer?.setData('application/x-arch-palette', entry.id);
        event.dataTransfer?.setData('text/plain', entry.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
        item.classList.add('is-dragging');
      });
      item.addEventListener('dragend', () => {
        draggingEntry = undefined;
        item.classList.remove('is-dragging');
      });
      // Click is the keyboard- and touch-friendly path to the same action.
      item.addEventListener('click', () => addFromPalette(entry, null));

      grid.appendChild(item);
    }
    host.appendChild(grid);
  }
}

function showSide(side: 'palette' | 'model'): void {
  state.side = side;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-side]')) {
    button.classList.toggle('is-active', button.getAttribute('data-side') === side);
  }
  el('palette').hidden = side !== 'palette';
  el('tree').hidden = side !== 'model';
  const filter = el<HTMLInputElement>('filter');
  filter.placeholder = side === 'palette' ? 'Search technologies…' : 'Filter elements…';
}

// --------------------------------------------------------------------- canvas


/**
 * Pointer capture, defensively.
 *
 * `setPointerCapture` throws `NotFoundError` whenever the pointer id is no
 * longer active — a pointer released between the event firing and the handler
 * running, a synthetic event, some touch hardware. An uncaught throw inside
 * `pointerdown` would abort the handler *before* it attached its move and up
 * listeners, leaving the canvas permanently mid-drag. Capture is an
 * optimisation here, not a requirement, so failing to get it is survivable.
 */
function capturePointer(target: HTMLElement, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Dragging still works through the listeners below.
  }
}

function releasePointer(target: HTMLElement, pointerId: number): void {
  try {
    target.releasePointerCapture(pointerId);
  } catch {
    // Already released, or never captured.
  }
}

function activeView(): DerivedView | undefined {
  return state.views.find((view) => view.id === state.activeViewId);
}

function renderCanvas(): void {
  const viewport = el('viewport');
  const hint = el('hint');
  const view = activeView();

  if (!state.model || !view) {
    viewport.innerHTML = '';
    hint.textContent = hasErrors(state.diagnostics)
      ? 'The model does not compile yet — see Problems below.'
      : 'No views defined. Add a `views { ... }` block to see a diagram.';
    return;
  }
  hint.textContent = '';

  const computed = layout(view, {
    direction: state.direction,
    overrides: state.pins[view.id] ?? {},
  });

  viewport.innerHTML = renderSvg(view, computed, {
    theme: (document.documentElement.dataset['theme'] as 'light' | 'dark') ?? 'dark',
    interactive: true,
    showLegend: false,
    // The tab strip already names the view, and the canvas provides the
    // surface — drawing either again shrinks the diagram into a card.
    showTitle: false,
    showBackground: false,
    workspaceName: state.model.workspace.name,
  });

  applyTransform();
  applySelectionStyles();
  wireCanvasInteractions();
}

function applyTransform(): void {
  const viewport = el('viewport');
  viewport.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  el('zoom').textContent = `${Math.round(state.zoom * 100)}%`;
}

function applySelectionStyles(): void {
  const viewport = el('viewport');
  for (const node of viewport.querySelectorAll('[data-arch-id]')) {
    node.classList.toggle('is-selected', node.getAttribute('data-arch-id') === state.selectedId);
  }
}

/**
 * Scales and centres the diagram to fit the canvas.
 *
 * Guarded and deferred to a frame, because callers fire this straight after
 * changing the DOM — switching view, toggling focus mode, dragging the
 * splitter. At that moment the canvas may not have been laid out yet, and
 * measuring a zero-or-stale size produces a zoom level that leaves the diagram
 * clipped. Retrying on the next frame is cheaper than every caller having to
 * know about layout timing.
 */
let fitPending = false;

function fitToViewport(attempt = 0): void {
  if (fitPending && attempt === 0) return;
  fitPending = true;

  requestAnimationFrame(() => {
    fitPending = false;
    const view = activeView();
    if (!view) return;
    const canvas = el('canvas');
    const svg = el('viewport').querySelector('svg');
    if (!svg) return;

    const width = Number(svg.getAttribute('width') ?? 0);
    const height = Number(svg.getAttribute('height') ?? 0);
    const available = { width: canvas.clientWidth, height: canvas.clientHeight };

    if (width === 0 || height === 0) return;
    if (available.width < 80 || available.height < 80) {
      // Not laid out yet. Try again, but do not loop forever.
      if (attempt < 5) fitToViewport(attempt + 1);
      return;
    }

    const padding = 28;
    const scale = Math.min(
      (available.width - padding * 2) / width,
      (available.height - padding * 2) / height,
      2.2,
    );
    state.zoom = Math.max(0.08, scale);
    state.panX = Math.round((available.width - width * state.zoom) / 2);
    state.panY = Math.round(Math.max(padding, (available.height - height * state.zoom) / 2));
    applyTransform();
  });
}

let interactionsWired = false;

function wireCanvasInteractions(): void {
  if (interactionsWired) return;
  interactionsWired = true;

  const canvas = el('canvas');

  // ---- zoom at the pointer, so the thing under the cursor stays put
  canvas.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const factor = Math.exp(-event.deltaY * 0.0016);
      const next = Math.min(4, Math.max(0.1, state.zoom * factor));
      const ratio = next / state.zoom;
      state.panX = pointerX - (pointerX - state.panX) * ratio;
      state.panY = pointerY - (pointerY - state.panY) * ratio;
      state.zoom = next;
      applyTransform();
    },
    { passive: false },
  );

  // ---- pointer down: either drag a node, or pan the canvas
  canvas.addEventListener('pointerdown', (event: PointerEvent) => {
    const target = event.target as HTMLElement | null;
    const nodeGroup = target?.closest('[data-arch-id]') as SVGGElement | null;
    const rect = canvas.getBoundingClientRect();

    if (nodeGroup) {
      const id = nodeGroup.getAttribute('data-arch-id');
      if (!id) return;

      // Shift-click a second element to connect the selected one to it. This
      // avoids a modal "connect mode" — the thing that makes drawing tools
      // feel like operating machinery.
      if (event.shiftKey && state.selectedId && state.selectedId !== id) {
        event.preventDefault();
        connectTo(id);
        return;
      }

      select(id);

      const view = activeView();
      if (!view) return;

      const computed = layout(view, {
        direction: state.direction,
        overrides: state.pins[view.id] ?? {},
      });
      const box = computed.nodes.find((candidate) => candidate.id === id);
      if (!box) return;

      const startX = event.clientX;
      const startY = event.clientY;
      let moved = false;
      nodeGroup.classList.add('is-dragging');
      capturePointer(canvas, event.pointerId);

      // A child may not be dragged out of the boundary that contains it: a
      // container floating outside its own system is not a layout choice, it is
      // a picture that contradicts the model.
      const parentId = state.model?.element(id)?.parentId;
      const parentBox = parentId
        ? computed.nodes.find((candidate) => candidate.id === parentId)
        : undefined;

      const onMove = (move: PointerEvent): void => {
        const dx = (move.clientX - startX) / state.zoom;
        const dy = (move.clientY - startY) / state.zoom;
        if (!moved && Math.hypot(dx, dy) < 3) return; // tolerate a shaky click
        moved = true;

        let x = Math.round(box.x + dx);
        let y = Math.round(box.y + dy);

        if (parentBox) {
          const inset = 12;
          const header = 38;
          x = Math.min(
            Math.max(x, parentBox.x + inset),
            parentBox.x + parentBox.width - box.width - inset,
          );
          y = Math.min(
            Math.max(y, parentBox.y + header),
            parentBox.y + parentBox.height - box.height - inset,
          );
        }

        const pins = state.pins[view.id] ?? {};
        pins[id] = { x, y };
        state.pins[view.id] = pins;
        renderCanvas();
      };

      const onUp = (): void => {
        releasePointer(canvas, event.pointerId);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        nodeGroup.classList.remove('is-dragging');
        if (moved) {
          savePins();
          setStatus('Position pinned. Layout is stored separately from the model.');
        }
      };

      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      return;
    }

    // ---- pan
    const startX = event.clientX - state.panX;
    const startY = event.clientY - state.panY;
    canvas.classList.add('is-panning');
    capturePointer(canvas, event.pointerId);
    void rect;

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

  // ---- double click jumps to the declaration in the source
  canvas.addEventListener('dblclick', (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    const group = target?.closest('[data-arch-id]');
    const id = group?.getAttribute('data-arch-id');
    if (id) revealInSource(id);
  });
}

function select(id: string | undefined): void {
  state.selectedId = id;
  applySelectionStyles();
  renderInspector();
  renderTree();
}

/** Puts the caret on the line where an element is declared. */
function revealInSource(id: string): void {
  const element = state.model?.element(id);
  if (!element || element.provenance.source !== 'declared' || !element.provenance.loc) return;

  showPane('source');
  const textarea = el<HTMLTextAreaElement>('code');
  const lines = state.source.split('\n');
  const lineIndex = Math.max(0, element.provenance.loc.line - 1);
  let offset = 0;
  for (let i = 0; i < lineIndex; i += 1) offset += (lines[i]?.length ?? 0) + 1;

  textarea.focus();
  textarea.setSelectionRange(offset, offset + (lines[lineIndex]?.length ?? 0));
  const lineHeight = 19;
  el('code-scroll').scrollTop = Math.max(0, (lineIndex - 4) * lineHeight);
  setStatus(`${element.name} — ${formatLoc(element.provenance.loc)}`);
}

// ----------------------------------------------------------------------- tabs

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
      state.selectedId = undefined;
      renderTabs();
      renderCanvas();
      renderInspector();
      window.setTimeout(fitToViewport, 0);
    });
    tabs.appendChild(button);
    // Keep the selected view visible when the strip overflows, otherwise
    // switching views with the arrow keys appears to do nothing.
    if (view.id === state.activeViewId) {
      window.setTimeout(() => button.scrollIntoView({ block: 'nearest', inline: 'nearest' }), 0);
    }
  }
}

// ----------------------------------------------------------------- explorer

function renderTree(): void {
  const tree = el('tree');
  tree.innerHTML = '';
  const model = state.model;
  if (!model) {
    tree.innerHTML = '<div class="empty">No model yet.</div>';
    return;
  }

  const filter = state.filter.trim().toLowerCase();
  const matches = (element: Element): boolean =>
    filter === '' ||
    element.name.toLowerCase().includes(filter) ||
    element.id.toLowerCase().includes(filter) ||
    (element.technology ?? '').toLowerCase().includes(filter) ||
    element.tags.some((tag) => tag.toLowerCase().includes(filter));

  const visible = (element: Element): boolean =>
    matches(element) || model.descendants(element.id).some(matches);

  const row = (element: Element, depth: number): void => {
    if (!visible(element)) return;
    const item = document.createElement('div');
    item.className = `tree-item${element.id === state.selectedId ? ' is-selected' : ''}`;
    item.style.paddingLeft = `${6 + depth * 12}px`;
    item.title = element.id;
    item.innerHTML =
      `<span class="tree-dot" style="background:${colourFor(element)}"></span>` +
      `<span class="tree-name">${escapeHtml(element.name)}</span>` +
      `<span class="tree-meta">${escapeHtml(element.subtype ?? element.kind)}</span>`;
    item.addEventListener('click', () => select(element.id));
    item.addEventListener('dblclick', () => revealInSource(element.id));
    tree.appendChild(item);
    for (const child of model.children(element.id)) row(child, depth + 1);
  };

  for (const root of model.roots()) row(root, 0);
  if (tree.children.length === 0) {
    tree.innerHTML = '<div class="empty">Nothing matches that filter.</div>';
  }
}

/** Mirrors the renderer's palette so the explorer reads as the same product. */
function colourFor(element: Element): string {
  if (element.tags.includes('external')) return '#64748b';
  switch (element.subtype) {
    case 'database':
      return '#7c3aed';
    case 'cache':
      return '#db2777';
    case 'queue':
    case 'topic':
      return '#d97706';
    case 'api':
      return '#0d9488';
    default:
      break;
  }
  switch (element.kind) {
    case 'person':
      return '#4f46e5';
    case 'container':
      return '#0891b2';
    case 'component':
      return '#0284c7';
    case 'deploymentNode':
    case 'infrastructureNode':
      return '#475569';
    default:
      return '#2563eb';
  }
}

// ---------------------------------------------------------------- inspector

function renderInspector(): void {
  const inspector = el('inspector');
  const model = state.model;
  const element = state.selectedId ? model?.element(state.selectedId) : undefined;

  if (!model) {
    inspector.innerHTML = '<div class="empty">No model loaded.</div>';
    return;
  }
  if (!element) {
    const view = activeView();
    inspector.innerHTML = view
      ? `<div class="empty">Select an element.<br /><br />
         <strong>${escapeHtml(view.title)}</strong><br />
         ${view.nodes.length} elements · ${view.edges.length} relationships<br /><br />
         Drag to pin · scroll to zoom<br />double-click to jump to the source</div>`
      : '<div class="empty">Select an element.</div>';
    return;
  }

  const rows: string[] = [];

  /** A read-only row, for things that are not safely editable in place. */
  const row = (key: string, value: string | undefined): void => {
    if (!value) return;
    rows.push(
      `<div class="inspect-row"><span class="inspect-key">${key}</span>` +
        `<span class="inspect-value">${escapeHtml(value)}</span></div>`,
    );
  };

  /**
   * An editable row. Committing writes back to the DSL source through the same
   * edit functions the canvas uses, so typing here and typing in the text pane
   * are genuinely the same operation.
   */
  const field = (key: string, property: string, value: string | undefined): void => {
    rows.push(
      `<div class="inspect-row"><span class="inspect-key">${key}</span>` +
        `<input class="inspect-input" data-property="${escapeHtml(property)}" ` +
        `value="${escapeHtml(value ?? '')}" placeholder="—" ` +
        `aria-label="${escapeHtml(key)}" /></div>`,
    );
  };

  field('Name', 'name', element.name);
  // The identifier is what every reference uses, so renaming it is a refactor
  // rather than an edit: it updates the declaration and all references at once.
  field('Identifier', 'localId', element.localId);
  row('Kind', element.subtype ? `${element.kind} · ${element.subtype}` : element.kind);
  field('Technology', 'technology', element.technology);
  field('Owner', 'owner', element.owner);
  field('Description', 'description', element.description);
  field('Source path', 'source', element.sourcePath);
  row('Instance of', element.instanceOf);
  field('URL', 'url', element.url);
  for (const key of Object.keys(element.properties).sort()) {
    row(key, element.properties[key]);
  }

  const provenance =
    element.provenance.source === 'declared'
      ? `<span class="chip">declared</span>` +
        (element.provenance.loc
          ? `<span class="chip">${escapeHtml(formatLoc(element.provenance.loc))}</span>`
          : '')
      : `<span class="chip is-inferred">inferred · ${escapeHtml(
          element.provenance.confidence,
        )}</span><span class="chip">${escapeHtml(element.provenance.detector)}</span>`;

  const tags = element.tags.map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join('');

  const relations = model.relationsOf(element.id);
  const relationHtml = relations
    .map((relation) => {
      const outgoing = relation.sourceId === element.id;
      const otherId = outgoing ? relation.destId : relation.sourceId;
      const other = model.element(otherId);
      return (
        `<div class="rel-item" data-goto="${escapeHtml(otherId)}">` +
        `<span class="rel-arrow">${outgoing ? '→' : '←'}</span> ${escapeHtml(other?.name ?? otherId)}` +
        (relation.description ? `<br /><span class="inspect-key">${escapeHtml(relation.description)}</span>` : '') +
        `</div>`
      );
    })
    .join('');

  const dependents = model.dependents(element.id).length;

  inspector.innerHTML =
    `<div class="inspect-title">${escapeHtml(element.name)}</div>` +
    `<div class="inspect-sub">${escapeHtml(element.id)}</div>` +
    `<div style="padding:0 4px 8px">${provenance}</div>` +
    rows.join('') +
    (tags ? `<div class="inspect-section">Tags</div><div style="padding:0 4px">${tags}</div>` : '') +
    `<div class="inspect-section">Relationships (${relations.length})</div>` +
    (relationHtml || '<div class="empty">None.</div>') +
    `<div class="inspect-section">Impact</div>` +
    `<div class="inspect-row"><span class="inspect-key">Dependents</span>` +
    `<span class="inspect-value">${dependents} element(s) would be affected by a change here</span></div>`;

  for (const node of inspector.querySelectorAll('[data-goto]')) {
    node.addEventListener('click', () => select(node.getAttribute('data-goto') ?? undefined));
  }

  // Commit an inspector edit on Enter or blur. Escape reverts.
  for (const input of inspector.querySelectorAll<HTMLInputElement>('.inspect-input')) {
    const property = input.getAttribute('data-property');
    if (!property) continue;
    const original = input.value;

    const commit = (): void => {
      const current = state.model?.element(element.id);
      if (!current || !state.model) return;
      const next = input.value.trim();
      if (next === original.trim()) return;
      if (property === 'name' && next === '') {
        input.value = original;
        setStatus('An element needs a name.', 'error');
        return;
      }

      if (property === 'localId') {
        const result = renameIdentifier(state.source, state.model, element.id, next);
        if (!applyEdit(result)) {
          input.value = original;
          return;
        }
        // The id changed, so the old selection no longer resolves.
        const parent = current.parentId;
        select(parent ? `${parent}.${next}` : next);
        return;
      }

      applyEdit(
        setElementProperty(
          state.source,
          state.model,
          element.id,
          property,
          next === '' ? undefined : next,
        ),
      );
    };

    input.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
      if (event.key === 'Escape') {
        input.value = original;
        input.blur();
      }
    });
    input.addEventListener('blur', commit);
  }
}

// ------------------------------------------------------- problems and checks

/**
 * Pasting a PlantUML file into the `.arch` pane used to produce one error per
 * line — eighty of them — which tells the user nothing except that the tool is
 * unhappy. It is a different language, and the useful response is to say so
 * once and offer to convert it.
 */
function renderWrongLanguageNotice(): boolean {
  if (!hasErrors(state.diagnostics)) return false;
  if (!looksLikePlantUml(state.source)) return false;

  const list = el('problems');
  const badge = el('problem-count');
  badge.textContent = '1';
  badge.className = 'badge is-warning';

  list.innerHTML =
    '<div class="notice">' +
    '<strong>This looks like PlantUML, not an .arch model.</strong>' +
    '<p>They are different languages. Archforge can read C4-PlantUML and turn it ' +
    'into a model you can lint, diff and drift-check.</p>' +
    '<button type="button" data-action="convert-puml">Convert to .arch</button>' +
    '</div>';

  for (const node of list.querySelectorAll('[data-action="convert-puml"]')) {
    node.addEventListener('click', convertFromPlantUml);
  }
  showPane('problems');
  return true;
}

function convertFromPlantUml(): void {
  const result = importPlantUml(state.source, 'pasted.puml');
  if (result.stats.elements === 0) {
    setStatus('No C4 elements were found in that PlantUML.', 'error');
    return;
  }
  const model = ArchModel.of(result.workspace);
  state.undo.push(state.source);
  state.redo = [];
  state.source = emitWorkspace(model, { annotateProvenance: false });
  el<HTMLTextAreaElement>('code').value = state.source;
  state.pins = {};
  recompile();
  window.setTimeout(fitToViewport, 30);

  const notes: string[] = [
    `${result.stats.elements} elements`,
    `${result.stats.relationships} relationships`,
  ];
  if (result.stats.synthesized > 0) notes.push(`${result.stats.synthesized} added for structure`);
  if (result.stats.skipped > 0) notes.push(`${result.stats.skipped} lines skipped`);
  setStatus(`Converted from PlantUML: ${notes.join(', ')}.`, 'success');
}

function renderProblems(): void {
  if (renderWrongLanguageNotice()) return;
  const list = el('problems');
  const sorted = sortDiagnostics(state.diagnostics);
  const errors = sorted.filter((d) => d.severity === 'error').length;

  const badge = el('problem-count');
  badge.textContent = String(sorted.length);
  badge.className = `badge${errors > 0 ? ' is-error' : ''}`;

  if (sorted.length === 0) {
    list.innerHTML = '<div class="empty">The model compiles cleanly.</div>';
    return;
  }

  list.innerHTML = sorted
    .map(
      (d) =>
        `<div class="list-item" data-line="${d.loc?.line ?? ''}">` +
        `<span class="list-icon is-${d.severity}">${d.severity === 'error' ? '✗' : d.severity === 'warning' ? '⚠' : 'i'}</span>` +
        `<span class="list-message">${escapeHtml(d.message)}` +
        (d.loc ? `<span class="list-loc">${escapeHtml(formatLoc(d.loc))}</span>` : '') +
        (d.hint ? `<span class="list-hint">${escapeHtml(d.hint)}</span>` : '') +
        `</span></div>`,
    )
    .join('');

  wireLineJumps(list);
}

function renderChecks(): void {
  const list = el('checks');
  const errors = state.violations.filter((v) => v.severity === 'error').length;
  const warnings = state.violations.filter((v) => v.severity === 'warning').length;

  const badge = el('violation-count');
  badge.textContent = String(state.violations.length);
  badge.className = `badge${errors > 0 ? ' is-error' : warnings > 0 ? ' is-warning' : ''}`;

  if (!state.model) {
    list.innerHTML = '<div class="empty">No model.</div>';
    return;
  }
  if (state.model.rules.length === 0) {
    list.innerHTML =
      '<div class="empty">No rules defined, so nothing was checked.<br />' +
      'Add a <code>rules { ... }</code> block to enforce architecture constraints.</div>';
    return;
  }
  if (state.violations.length === 0) {
    list.innerHTML = `<div class="empty">All ${state.model.rules.length} rules pass.</div>`;
    return;
  }

  list.innerHTML = state.violations
    .map(
      (violation) =>
        `<div class="list-item" data-line="${violation.loc?.line ?? ''}" data-select="${escapeHtml(
          violation.elementId ?? '',
        )}">` +
        `<span class="list-icon is-${violation.severity}">${
          violation.severity === 'error' ? '✗' : violation.severity === 'warning' ? '⚠' : 'i'
        }</span>` +
        `<span class="list-message"><span class="list-rule">${escapeHtml(violation.ruleId)}</span>` +
        `${escapeHtml(violation.message)}` +
        (violation.loc ? `<span class="list-loc">${escapeHtml(formatLoc(violation.loc))}</span>` : '') +
        (violation.detail ? `<span class="list-hint">${escapeHtml(violation.detail)}</span>` : '') +
        `</span></div>`,
    )
    .join('');

  wireLineJumps(list);
}

function wireLineJumps(list: HTMLElement): void {
  for (const node of list.querySelectorAll('[data-line]')) {
    node.addEventListener('click', () => {
      const id = node.getAttribute('data-select');
      if (id) select(id);
      const line = Number(node.getAttribute('data-line'));
      if (!Number.isFinite(line) || line <= 0) return;
      showPane('source');
      const textarea = el<HTMLTextAreaElement>('code');
      const lines = state.source.split('\n');
      let offset = 0;
      for (let i = 0; i < line - 1; i += 1) offset += (lines[i]?.length ?? 0) + 1;
      textarea.focus();
      textarea.setSelectionRange(offset, offset + (lines[line - 1]?.length ?? 0));
      el('code-scroll').scrollTop = Math.max(0, (line - 5) * 19);
    });
  }
}

// ----------------------------------------------------------------- highlight

/**
 * Syntax highlighting by running the engine's own lexer over the source, so the
 * editor can never disagree with the compiler about what a token is.
 */
const KEYWORDS = new Set([
  'workspace', 'person', 'actor', 'system', 'softwareSystem', 'container', 'component',
  'database', 'queue', 'topic', 'api', 'service', 'browser', 'mobileApp', 'function', 'cache',
  'deploymentNode', 'node', 'infrastructureNode', 'infra',
  'views', 'rules', 'rule', 'context', 'deployment', 'dynamic', 'of',
  'description', 'technology', 'tech', 'owner', 'team', 'url', 'kind', 'subtype', 'icon',
  'source', 'instanceOf', 'instances', 'title', 'protocol', 'include', 'exclude', 'external',
  'prop', 'property', 'tag', 'tags',
  'severity', 'forbid', 'allow', 'require', 'cycles', 'orphans', 'on', 'in',
  'error', 'warning', 'info', 'element',
]);

function highlight(): void {
  const source = state.source;
  const { tokens } = lex(source, 'architecture.arch');

  // Build an offset index so token positions map back into the raw text and
  // everything between tokens (whitespace, comments) is preserved verbatim.
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }
  const offsetOf = (line: number, column: number): number =>
    (lineStarts[line - 1] ?? 0) + column - 1;

  let cursor = 0;
  let html = '';

  for (const token of tokens) {
    if (token.type === 'eof') break;
    const start = offsetOf(token.loc.line, token.loc.column);
    if (start < cursor) continue;

    // Gap text: whitespace and comments the lexer skipped.
    const gap = source.slice(cursor, start);
    if (gap !== '') html += highlightGap(gap);

    const raw = rawTokenText(source, start, token.type, token.value);
    const className =
      token.type === 'string'
        ? 'tok-string'
        : token.type === 'number'
          ? 'tok-number'
          : token.type === 'arrow' || token.type === 'biarrow'
            ? 'tok-arrow'
            : token.type === 'ident'
              ? KEYWORDS.has(token.value)
                ? 'tok-keyword'
                : 'tok-ident'
              : 'tok-punct';

    html += `<span class="${className}">${escapeHtml(raw)}</span>`;
    cursor = start + raw.length;
  }

  if (cursor < source.length) html += highlightGap(source.slice(cursor));

  // A trailing newline keeps the mirror's height in step with the textarea.
  el('highlight').innerHTML = `${html}\n`;
  renderGutter();
  syncScroll();
}

/** Comments are the only meaningful content in the gaps between tokens. */
function highlightGap(gap: string): string {
  let out = '';
  const pattern = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(gap)) !== null) {
    out += escapeHtml(gap.slice(last, match.index));
    out += `<span class="tok-comment">${escapeHtml(match[0])}</span>`;
    last = match.index + match[0].length;
  }
  out += escapeHtml(gap.slice(last));
  return out;
}

/**
 * Recovers a token's original text. The lexer decodes string values, so the
 * mirror must re-read the raw slice or the highlighted text would drift out of
 * alignment with the textarea underneath it.
 */
function rawTokenText(source: string, start: number, type: string, value: string): string {
  if (type !== 'string') return value;
  if (source.startsWith('"""', start)) {
    const end = source.indexOf('"""', start + 3);
    return end < 0 ? source.slice(start) : source.slice(start, end + 3);
  }
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === '"' || source[index] === '\n') break;
    index += 1;
  }
  return source.slice(start, Math.min(index + 1, source.length));
}

function renderGutter(): void {
  const errorLines = new Set(
    state.diagnostics.filter((d) => d.severity === 'error').map((d) => d.loc?.line ?? -1),
  );
  const count = state.source.split('\n').length;
  const parts: string[] = [];
  for (let line = 1; line <= count; line += 1) {
    parts.push(`<span class="${errorLines.has(line) ? 'has-error' : ''}">${line}</span>`);
  }
  el('gutter').innerHTML = parts.join('');
}

function syncScroll(): void {
  const scroll = el('code-scroll');
  el('gutter').scrollTop = scroll.scrollTop;
}

// ----------------------------------------------------------------- generated

/**
 * Live preview of the model in an interchange format.
 *
 * The `.arch` source is the model; these are projections of it, so the pane is
 * read-only. Showing them live matters because the usual worry about adopting
 * a new DSL is "what do I get out of it?" — the answer should be visible at
 * all times, not discovered after an export.
 */
function renderGenerated(): void {
  const host = el('generated');
  const model = state.model;
  const view = activeView();

  if (!model) {
    host.textContent = 'The model does not compile yet.';
    return;
  }

  const format = el<HTMLSelectElement>('generated-format').value;
  const direction = state.direction;

  try {
    switch (format) {
      case 'mermaid':
        host.textContent = view ? toMermaid(view, { direction }) : 'No view selected.';
        break;
      case 'json':
        host.textContent = canonicalJson(model.workspace);
        break;
      case 'svg':
        host.textContent = view
          ? renderSvg(view, layout(view, { direction, overrides: state.pins[view.id] ?? {} }), {
              theme: 'light',
              workspaceName: model.workspace.name,
            })
          : 'No view selected.';
        break;
      default:
        host.textContent = view ? toPlantUml(model, view, { direction }) : 'No view selected.';
    }
  } catch (error) {
    host.textContent = `Could not generate: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

// --------------------------------------------------------------------- panes

function showPane(name: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-pane]')) {
    button.classList.toggle('is-active', button.getAttribute('data-pane') === name);
  }
  for (const pane of document.querySelectorAll<HTMLElement>('[data-pane-body]')) {
    pane.classList.toggle('is-active', pane.getAttribute('data-pane-body') === name);
  }
  const generated = name === 'generated';
  el('generated-controls').hidden = !generated;
  el('editor-hint').textContent = generated
    ? 'generated from the model — read only'
    : 'the model is the source of truth — edit here';
  if (generated) renderGenerated();
}

// ------------------------------------------------------------------- exports

function exportAs(format: string): void {
  const model = state.model;
  if (!model) {
    setStatus('Nothing to export — the model does not compile.', 'error');
    return;
  }
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
    case 'svg': {
      if (!view) return;
      download(`${view.id}.svg`, currentSvg(), 'image/svg+xml');
      break;
    }
    case 'puml': {
      if (!view) return;
      download(`${view.id}.puml`, toPlantUml(model, view, { direction: state.direction }));
      break;
    }
    case 'mermaid': {
      if (!view) return;
      download(`${view.id}.mmd`, toMermaid(view, { direction: state.direction }));
      break;
    }
    case 'png': {
      if (!view) return;
      void exportPng(view.id);
      break;
    }
    case 'all': {
      // A single readable bundle rather than a zip, since zipping would mean
      // either a dependency or hand-rolling deflate for little benefit.
      const parts: string[] = [`# ${model.workspace.name}\n`, '## Model source\n', '```', state.source, '```\n'];
      for (const derived of state.views) {
        parts.push(`## View: ${derived.title} (PlantUML)\n`, '```plantuml', toPlantUml(model, derived, {}), '```\n');
        parts.push(`## View: ${derived.title} (Mermaid)\n`, '```mermaid', toMermaid(derived, {}), '```\n');
      }
      parts.push('## Documentation\n', documentWorkspace(model, state.views, {}));
      download(`${base}-bundle.md`, parts.join('\n'), 'text/markdown');
      break;
    }
    default:
      return;
  }
  setStatus('Exported.', 'success');
}

/** The active view rendered without editor hooks, for a clean export. */
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

async function exportPng(name: string): Promise<void> {
  const svg = currentSvg();
  const match = /width="(\d+)" height="(\d+)"/.exec(svg);
  const width = Number(match?.[1] ?? 1200);
  const height = Number(match?.[2] ?? 800);
  const scale = 2; // retina-quality raster

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

// ------------------------------------------------------------------- imports

function importFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result ?? '');
    if (/\.(puml|plantuml|iuml|wsd)$/i.test(file.name) || looksLikePlantUml(text)) {
      state.source = text;
      el<HTMLTextAreaElement>('code').value = text;
      convertFromPlantUml();
      return;
    }
    if (file.name.endsWith('.json')) {
      // A model JSON export: re-emit it as DSL so the user gets source they own.
      try {
        const workspace = JSON.parse(text) as Parameters<typeof ArchModel.of>[0];
        setSource(emitWorkspace(ArchModel.of(workspace)));
        setStatus(`Imported ${file.name} and converted it to DSL.`, 'success');
      } catch {
        setStatus('That JSON is not an Archforge model.', 'error');
      }
      return;
    }
    setSource(text);
    setStatus(`Imported ${file.name}.`, 'success');
  };
  reader.readAsText(file);
}

/**
 * Scans a dropped folder in the browser and synthesises a model from it.
 * Runs the same detectors the CLI runs; no code leaves the tab.
 */
async function analyzeFolder(files: readonly File[]): Promise<void> {
  if (files.length === 0) return;
  setStatus(`Scanning ${files.length} files…`);

  const source = fileSourceFromFileList(files);
  const scan = await scanRepository(source);
  const rootName = files[0]?.webkitRelativePath?.split('/')[0] ?? 'Scanned system';
  const workspace = synthesizeWorkspace(scan, { name: rootName });

  if (workspace.elements.length <= 1) {
    setStatus('Scanned, but no recognisable architecture was found.', 'error');
    return;
  }

  setSource(emitWorkspace(ArchModel.of(workspace), { annotateProvenance: true }));
  setStatus(
    `Found ${scan.components.length} components and ${scan.externals.length} dependencies ` +
      `across ${scan.languages.join(', ') || 'unknown stacks'}. Everything is marked inferred — review it.`,
    'success',
  );
}

function setSource(text: string): void {
  state.source = text;
  el<HTMLTextAreaElement>('code').value = text;
  state.pins = {};
  pendingPins = {};
  savePins();
  recompile();
  window.setTimeout(fitToViewport, 30);
}

// ---------------------------------------------------------------------- boot

const TEMPLATE = `workspace "My Platform" {

  description "Replace this with what the platform is for."

  person customer "Customer" {
    description "Uses the platform."
  }

  system platform "My Platform" {
    description "The system being described."
    owner "platform-team"

    container web "Web app" {
      technology "TypeScript / React"
      kind browser
    }

    container api "API" {
      technology "Node 22 / Fastify"
      source "services/api"
      tag internal
    }

    database db "Primary database" {
      technology "PostgreSQL 16"
    }
  }

  customer -> platform.web "Uses" { technology "HTTPS" }
  platform.web -> platform.api "Calls" { technology "HTTPS/JSON" }
  platform.api -> platform.db "Reads and writes" { technology "SQL" }

  views {
    context landscape "System landscape" of platform
    container containers "Containers" of platform
  }

  rules {
    rule no-cycles "Architecture must be acyclic" {
      severity error
      forbid cycles
    }

    rule owned "Every container has an owner" {
      severity warning
      require owner on element(kind:container)
    }
  }
}
`;

function wireChrome(): void {
  // ---- editor text
  const textarea = el<HTMLTextAreaElement>('code');
  textarea.addEventListener('input', () => {
    state.source = textarea.value;
    scheduleCompile();
  });
  textarea.addEventListener('keydown', (event: KeyboardEvent) => {
    // Tab inserts two spaces rather than leaving the editor.
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
  el('code-scroll').addEventListener('scroll', syncScroll);

  // ---- pane tabs
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-pane]')) {
    button.addEventListener('click', () => showPane(button.getAttribute('data-pane') ?? 'source'));
  }

  // ---- toolbar
  const actions: Record<string, () => void> = {
    new: () => {
      setSource(TEMPLATE);
      setStatus('New model from template.', 'success');
    },
    example: () => {
      // The large model, deliberately: it shows derived views, boundaries,
      // icon coverage and rule evaluation at a scale that proves the point.
      void fetch('../examples/globex-commerce.arch')
        .then((response) => (response.ok ? response.text() : Promise.reject(new Error('not found'))))
        .then((text) => {
          setSource(text);
          setStatus('Loaded Globex Commerce — 107 elements, 13 views.', 'success');
        })
        .catch(() => setStatus('Example not available in this build.', 'error'));
    },
    import: () => el<HTMLInputElement>('file-input').click(),
    analyze: () => el<HTMLInputElement>('folder-input').click(),
    direction: () => {
      state.direction = state.direction === 'TB' ? 'LR' : 'TB';
      el('direction').textContent = state.direction;
      renderCanvas();
      fitToViewport();
    },
    fit: fitToViewport,
    focus: () => {
      const app = document.querySelector('.app');
      const on = app?.classList.toggle('is-focus') ?? false;
      localStorage.setItem('archforge.focus', on ? '1' : '0');
      window.setTimeout(fitToViewport, 30);
      setStatus(on ? 'Canvas only. Press \\ or Focus to bring the panels back.' : '');
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
      state.zoom = Math.max(0.1, state.zoom / 1.2);
      applyTransform();
    },
    undo,
    redo,
    'reset-pins': () => {
      const view = activeView();
      if (!view) return;
      delete state.pins[view.id];
      savePins();
      renderCanvas();
      fitToViewport();
      setStatus('Manual positions cleared for this view.');
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

  // ---- file inputs
  el<HTMLInputElement>('file-input').addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) importFile(file);
  });
  el<HTMLInputElement>('folder-input').addEventListener('change', (event) => {
    const files = [...((event.target as HTMLInputElement).files ?? [])];
    void analyzeFolder(files);
  });

  // ---- filter drives whichever pane is showing
  const filter = el<HTMLInputElement>('filter');
  filter.addEventListener('input', () => {
    state.filter = filter.value;
    if (state.side === 'palette') renderPalette();
    else renderTree();
  });

  // ---- generated-format preview
  const generatedFormat = el<HTMLSelectElement>('generated-format');
  generatedFormat.addEventListener('change', renderGenerated);
  for (const node of document.querySelectorAll('[data-action="copy-generated"]')) {
    node.addEventListener('click', () => {
      const text = el('generated').textContent ?? '';
      void navigator.clipboard
        .writeText(text)
        .then(() => setStatus(`Copied ${generatedFormat.value} to the clipboard.`, 'success'))
        .catch(() => setStatus('Could not access the clipboard.', 'error'));
    });
  }

  // ---- splitter between the canvas and the source pane
  const splitter = el('splitter');
  splitter.addEventListener('pointerdown', (event: PointerEvent) => {
    event.preventDefault();
    splitter.classList.add('is-dragging');
    capturePointer(splitter, event.pointerId);

    const onMove = (move: PointerEvent): void => {
      // Clamp so neither pane can be dragged out of existence.
      const height = Math.min(
        Math.max(window.innerHeight - move.clientY - 3, 90),
        window.innerHeight - 220,
      );
      document.documentElement.style.setProperty('--editor-h', `${Math.round(height)}px`);
    };
    const onUp = (): void => {
      releasePointer(splitter, event.pointerId);
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
      splitter.classList.remove('is-dragging');
      localStorage.setItem(
        'archforge.editorHeight',
        document.documentElement.style.getPropertyValue('--editor-h'),
      );
      applyTransform();
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
  });
  // Double-click the handle to collapse or restore the source pane.
  splitter.addEventListener('dblclick', () => {
    const current = document.documentElement.style.getPropertyValue('--editor-h');
    const collapsed = current === '90px';
    const next = collapsed ? '320px' : '90px';
    document.documentElement.style.setProperty('--editor-h', next);
    localStorage.setItem('archforge.editorHeight', next);
  });

  // ---- palette tabs and search
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-side]')) {
    button.addEventListener('click', () =>
      showSide((button.getAttribute('data-side') as 'palette' | 'model') ?? 'palette'),
    );
  }

  // ---- dropping a palette entry onto the canvas
  const canvasEl = el('canvas');
  const isPaletteDrag = (event: DragEvent): boolean =>
    draggingEntry !== undefined ||
    (event.dataTransfer?.types.includes('application/x-arch-palette') ?? false);

  canvasEl.addEventListener('dragover', (event: DragEvent) => {
    if (!isPaletteDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    canvasEl.classList.add('is-drop-target');

    // Highlight the boundary that would receive the drop, so the nesting is
    // visible before committing rather than a surprise afterwards.
    for (const node of canvasEl.querySelectorAll('.is-drop-parent')) {
      node.classList.remove('is-drop-parent');
    }
    const target = event.target as HTMLElement | null;
    const parentId = draggingEntry ? dropParentFor(draggingEntry, target) : undefined;
    if (parentId) {
      canvasEl
        .querySelector(`.arch-boundary[data-arch-id="${CSS.escape(parentId)}"]`)
        ?.classList.add('is-drop-parent');
    }
  });

  const clearDropFeedback = (): void => {
    canvasEl.classList.remove('is-drop-target');
    for (const node of canvasEl.querySelectorAll('.is-drop-parent')) {
      node.classList.remove('is-drop-parent');
    }
  };
  canvasEl.addEventListener('dragleave', clearDropFeedback);

  canvasEl.addEventListener('drop', (event: DragEvent) => {
    if (!isPaletteDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    clearDropFeedback();
    const entryId = event.dataTransfer?.getData('application/x-arch-palette');
    const entry = (entryId ? paletteEntry(entryId) : undefined) ?? draggingEntry;
    draggingEntry = undefined;
    if (entry) addFromPalette(entry, event.target as HTMLElement | null);
  });

  // ---- drag and drop a folder or file anywhere on the page
  const overlay = el('drop-overlay');
  let dragDepth = 0;
  // Only react to actual files: a palette drag also fires these events, and
  // covering the screen with a "drop a folder" overlay mid-drag is hostile.
  const isFileDrag = (event: DragEvent): boolean =>
    event.dataTransfer?.types.includes('Files') ?? false;

  window.addEventListener('dragenter', (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth += 1;
    overlay.hidden = false;
  });
  window.addEventListener('dragover', (event: DragEvent) => {
    if (isFileDrag(event)) event.preventDefault();
  });
  window.addEventListener('dragleave', (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.hidden = true;
  });
  window.addEventListener('drop', (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;

    const items = [...(event.dataTransfer?.files ?? [])];
    if (items.length === 1 && /\.(arch|af|json)$/.test(items[0]?.name ?? '')) {
      importFile(items[0] as File);
      return;
    }
    if (items.length > 0) void analyzeFolder(items);
  });

  // ---- keyboard shortcuts
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    const typing =
      document.activeElement === textarea ||
      document.activeElement instanceof HTMLInputElement;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      exportAs('arch');
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      // Inside the textarea the browser's own undo is better than ours.
      if (document.activeElement === textarea) return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (typing) return;

    if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedId) {
      event.preventDefault();
      deleteSelected();
      return;
    }

    if (event.key === 'f') fitToViewport();
    if (event.key === '\\') actions['focus']?.();
    if (event.key === '+' || event.key === '=') actions['zoom-in']?.();
    if (event.key === '-') actions['zoom-out']?.();
    if (event.key === 'Escape') select(undefined);
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const index = state.views.findIndex((view) => view.id === state.activeViewId);
      const next = event.key === 'ArrowRight' ? index + 1 : index - 1;
      const view = state.views[(next + state.views.length) % state.views.length];
      if (view) {
        state.activeViewId = view.id;
        renderTabs();
        renderCanvas();
        fitToViewport();
      }
    }
  });

  window.addEventListener('resize', () => applyTransform());
}

function boot(): void {
  const savedTheme = localStorage.getItem(STORAGE.theme);
  if (savedTheme) document.documentElement.dataset['theme'] = savedTheme;

  const savedHeight = localStorage.getItem('archforge.editorHeight');
  if (savedHeight) document.documentElement.style.setProperty('--editor-h', savedHeight);
  if (localStorage.getItem('archforge.focus') === '1') {
    document.querySelector('.app')?.classList.add('is-focus');
  }

  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE.pins) ?? '{}') as {
      signature?: string;
      pins?: Pins;
    };
    // Applied only after the model is known to match; see recompile().
    pendingPins = stored.signature !== undefined ? stored : { signature: '', pins: {} };
  } catch {
    pendingPins = { signature: '', pins: {} };
  }
  state.activeViewId = localStorage.getItem(STORAGE.view) ?? undefined;
  state.source = localStorage.getItem(STORAGE.source) ?? TEMPLATE;

  el<HTMLTextAreaElement>('code').value = state.source;
  el('direction').textContent = state.direction;

  wireChrome();
  showSide('palette');
  renderPalette();
  recompile();
  window.setTimeout(fitToViewport, 50);
}

boot();
