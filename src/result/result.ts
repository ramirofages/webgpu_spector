// Results page entry point.

import { STORAGE_INDEX_KEY, type CaptureIndexEntry, type CaptureResultMessage } from '../shared/protocol';
import type { Ctx, ShaderStageRef } from './ctx';
import { clear, h } from './dom';
import { buildModel, type Model, type TreeNode } from './model';
import { openImageModal, openShaderModal } from './modals';
import { objectTitle, renderObject } from './objects';
import { ChromeStore, EXPORT_FORMAT, MemoryStore, hasChromeStorage, importToChrome, type CaptureStore } from './store';
import { CommandsView, ResourcesView, infoView } from './views';

const app = document.getElementById('app')!;

function fatal(msg: string): void
{
  clear(app);
  app.append(h('div', { class: 'fatal' }, msg));
}

class Drawer
{
  private el: HTMLElement | null = null;
  private stack: number[] = [];

  constructor(private ctx: () => Ctx) {}

  open(id: number, push = true): void
  {
    if (push) this.stack.push(id);
    if (!this.el)
    {
      this.el = h('div', { class: 'drawer' });
      document.body.append(this.el);
    }
    clear(this.el);
    const back = h('button', { class: 'btn small', disabled: this.stack.length < 2, on: { click: () => { this.stack.pop(); this.open(this.stack[this.stack.length - 1], false); } } }, '←');
    const crumbs = h('div', { class: 'crumbs' }, this.stack.slice(-3).map((sid, i, arr) =>
      h('span', null, `${objectTitle(this.ctx().cap.objects[sid])}${i < arr.length - 1 ? '  ›' : ''}`)));
    this.el.append(
      h('div', { class: 'd-head' }, back, crumbs, h('button', { class: 'btn small', on: { click: () => this.close() } }, '✕')),
      h('div', { class: 'd-body' }, renderObject(this.ctx(), id))
    );
  }

  close(): void
  {
    this.el?.remove();
    this.el = null;
    this.stack = [];
  }

  get isOpen(): boolean
  {
    return !!this.el;
  }
}

async function loadIndex(): Promise<CaptureIndexEntry[]>
{
  if (!hasChromeStorage) return [];
  const r = await chrome.storage.local.get(STORAGE_INDEX_KEY);
  return (r[STORAGE_INDEX_KEY] ?? []) as CaptureIndexEntry[];
}

function download(name: string, text: string): void
{
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function start(store: CaptureStore): Promise<void>
{
  let cap;
  try
  {
    cap = await store.load();
  }
  catch (e: any)
  {
    fatal(e?.message ?? String(e));
    return;
  }

  let model: Model;
  try
  {
    model = buildModel(cap);
  }
  catch (e: any)
  {
    console.error(e);
    fatal(`Could not read this capture: ${e?.message ?? e}`);
    return;
  }

  const snapUseIndex = new Map<number, { node: TreeNode; role: string }[]>();
  const addUse = (id: number | null | undefined, node: TreeNode, role: string) =>
  {
    if (id === null || id === undefined) return;
    const l = snapUseIndex.get(id) ?? [];
    l.push({ node, role });
    snapUseIndex.set(id, l);
  };
  for (const v of model.visual)
  {
    v.snaps.c.forEach((id, i) => addUse(id, v.node, v.passEnd ? `pass end, color ${i}` : `after draw, color ${i}`));
    addUse(v.snaps.d, v.node, v.passEnd ? 'pass end, depth' : 'after draw, depth');
  }
  for (const p of model.passes)
  {
    for (const id of Object.values(p.json.texSnaps)) addUse(id, p.node, 'sampled');
  }

  const drawer = new Drawer(() => ctx);
  let commands: CommandsView;
  let resources: ResourcesView;
  const views: Record<string, HTMLElement> = {};
  const tabButtons: Record<string, HTMLElement> = {};

  const showTab = (name: string) =>
  {
    for (const [k, v] of Object.entries(views)) v.classList.toggle('active', k === name);
    for (const [k, b] of Object.entries(tabButtons)) b.classList.toggle('active', k === name);
    if (name !== 'commands') drawer.close();
    try
    {
      localStorage.setItem('tab', name);
    }
    catch { /* ignore */ }
  };

  const ctx: Ctx = {
    cap,
    model,
    store,
    obj: (ref: any) => (ref && typeof ref === 'object' && typeof ref.$ref === 'number' ? cap.objects[ref.$ref] : undefined),
    openObject: (id: number) =>
    {
      if (views.resources?.classList.contains('active')) resources.show(id);
      else drawer.open(id);
    },
    openShader: (stages: ShaderStageRef[], focus?: number, highlight?: { group: number; binding: number }) => openShaderModal(ctx, stages, focus, highlight),
    openImage: (snapId: number, title?: string) => openImageModal(ctx, snapId, title),
    selectNode: (node: TreeNode, scroll = true) =>
    {
      drawer.close();
      commands.select(node, scroll);
    },
    snapUses: (id: number) => snapUseIndex.get(id) ?? [],
    showTab
  };

  // -- header -------------------------------------------------------------------------

  const m = cap.meta;
  let host = m.url;
  try
  {
    host = new URL(m.url).host || m.url;
  }
  catch { /* keep */ }
  const index = await loadIndex();
  const picker = h('select', { class: 'btn', title: 'Other captures' });
  if (index.length)
  {
    for (const e of index)
    {
      const opt = h('option', { value: e.id }, `${new Date(e.time).toLocaleTimeString()} · ${e.title || e.url}`.slice(0, 80));
      if (e.id === store.id) opt.selected = true;
      picker.append(opt);
    }
    picker.addEventListener('change', () =>
    {
      location.search = `?id=${encodeURIComponent(picker.value)}`;
    });
  }
  else picker.hidden = true;

  const exportBtn = h('button', { class: 'btn', title: 'Save this capture as a file (to share it or open it later)' }, 'Export');
  exportBtn.addEventListener('click', async () =>
  {
    exportBtn.textContent = 'Exporting…';
    try
    {
      const data = await store.exportAll();
      const stamp = new Date(m.time).toISOString().replace(/[:.]/g, '-').slice(0, 19);
      download(`webgpu-capture-${host.replace(/[^\w.-]/g, '_')}-${stamp}.json`, JSON.stringify({ format: EXPORT_FORMAT, version: 1, ...data }));
    }
    finally
    {
      exportBtn.textContent = 'Export';
    }
  });

  const fileInput = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  const importBtn = h('button', { class: 'btn', title: 'Open a capture file' }, 'Import');
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () =>
  {
    const f = fileInput.files?.[0];
    if (!f) return;
    try
    {
      const data = JSON.parse(await f.text());
      if (data.format !== EXPORT_FORMAT || !data.capture) throw new Error('not a WebGPU Spector capture file');
      const msg: CaptureResultMessage = { capture: data.capture, images: data.images ?? {}, buffers: data.buffers ?? {} };
      if (hasChromeStorage)
      {
        const id = await importToChrome(msg);
        location.search = `?id=${encodeURIComponent(id)}`;
      }
      else
      {
        clear(app);
        app.append(h('div', { class: 'loading' }, 'Loading…'));
        start(new MemoryStore('imported', msg));
      }
    }
    catch (e: any)
    {
      alert(`Could not import: ${e?.message ?? e}`);
    }
  });

  const header = h('header', { class: 'top' },
    h('div', { class: 'brand' }, h('img', { src: 'icons/icon32.png', alt: '' }), 'WebGPU Spector'),
    h('nav', { class: 'tabs' },
      tabButtons.commands = h('button', { on: { click: () => showTab('commands') } }, 'Commands'),
      tabButtons.resources = h('button', { on: { click: () => showTab('resources') } }, 'Resources'),
      tabButtons.info = h('button', { on: { click: () => showTab('info') } }, 'Info')
    ),
    h('div', { class: 'capinfo', title: m.url },
      h('div', { class: 't' }, m.title || host),
      h('div', { class: 's' }, `${host} · ${new Date(m.time).toLocaleString()} · ${m.stats.draws ?? 0} draws · ${m.stats.renderPasses ?? 0} render passes${m.warnings.length ? ` · ${m.warnings.length} warning${m.warnings.length === 1 ? '' : 's'}` : ''}`)
    ),
    h('div', { class: 'actions' }, picker, exportBtn, importBtn, fileInput)
  );

  document.title = `WebGPU capture · ${m.title || host}`;
  clear(app);
  const main = h('main');
  app.append(header, main);

  commands = new CommandsView(ctx);
  resources = new ResourcesView(ctx);
  views.commands = commands.el;
  views.resources = resources.el;
  views.info = h('div', { class: 'view' }, infoView(ctx));
  main.append(views.commands, views.resources, views.info);

  let tab = 'commands';
  try
  {
    tab = localStorage.getItem('tab') ?? 'commands';
  }
  catch { /* ignore */ }
  showTab(views[tab] ? tab : 'commands');
  commands.focus();

  document.addEventListener('keydown', (e) =>
  {
    if (e.key === 'Escape' && drawer.isOpen && !document.querySelector('.modal-back')) drawer.close();
  });
}

// -- boot ------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const id = params.get('id');

if (id && hasChromeStorage)
{
  start(new ChromeStore(id));
}
else if (params.has('dev'))
{
  // Dev harness: the opener / parent posts the capture to us.
  window.addEventListener('message', (e) =>
  {
    if (e.data?.type === 'webgpu-spector:capture' && e.data.result) start(new MemoryStore('dev', e.data.result));
  });
  (window.opener ?? window.parent)?.postMessage({ type: 'webgpu-spector:ready' }, '*');
}
else if (hasChromeStorage)
{
  loadIndex().then((index) =>
  {
    if (index.length) location.search = `?id=${encodeURIComponent(index[0].id)}`;
    else fatal('No capture yet. Open a page that uses WebGPU, click the extension icon and press "Capture frame".');
  });
}
else
{
  fatal('Open this page from the extension.');
}
