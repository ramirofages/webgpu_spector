// The three tabs: Commands (visual states + command tree + details), Resources, Info.

import type { Ctx } from './ctx';
import { clear, debounce, fmtBytes, h, kv } from './dom';
import { renderDetails } from './details';
import { buildModel, shortType, type TreeNode, type VisualState } from './model';
import { limitsTable, objectTitle, renderObject } from './objects';
import { computeVertexStats } from './stats';
import { ptree, refLink } from './widgets';

const ROW_H = 22;

function splitter(target: HTMLElement, key: string, side: 'left' | 'right', min = 160): HTMLElement
{
  const s = h('div', { class: 'splitter' });
  try
  {
    const w = localStorage.getItem(`w:${key}`);
    if (w) target.style.width = `${w}px`;
  }
  catch { /* ignore */ }
  s.addEventListener('mousedown', (e) =>
  {
    e.preventDefault();
    const startX = e.clientX;
    const startW = target.getBoundingClientRect().width;
    s.classList.add('dragging');
    const move = (ev: MouseEvent) =>
    {
      const dx = ev.clientX - startX;
      const w = Math.max(min, side === 'left' ? startW + dx : startW - dx);
      target.style.width = `${w}px`;
    };
    const up = () =>
    {
      s.classList.remove('dragging');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      try
      {
        localStorage.setItem(`w:${key}`, String(Math.round(target.getBoundingClientRect().width)));
      }
      catch { /* ignore */ }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  return s;
}

// ---------------------------------------------------------------------------

export class CommandsView
{
  el: HTMLElement;
  private vsBody: HTMLElement;
  private treeBody: HTMLElement;
  private treeInner: HTMLElement;
  private detailsBody: HTMLElement;
  private expanded = new Set<string>();
  private rows: TreeNode[] = [];
  private selected: TreeNode | null = null;
  private filter = '';
  private drawsOnly = false;
  private cards = new Map<TreeNode, HTMLElement>();
  private observer: IntersectionObserver;

  constructor(private ctx: Ctx)
  {
    const m = ctx.model;
    for (const n of m.byKey.values())
    {
      if (n.children.length && n.kind !== 'bundle' && n.cmd?.n !== 'executeBundles') this.expanded.add(n.key);
    }

    this.observer = new IntersectionObserver((entries) =>
    {
      for (const e of entries)
      {
        if (!e.isIntersecting) continue;
        const img = e.target as HTMLImageElement;
        this.observer.unobserve(img);
        const id = img.dataset.snap;
        if (id) ctx.store.image(id).then((url) => { if (url && url.startsWith('data:image/')) img.src = url; });
      }
    }, { rootMargin: '400px' });

    // Visual states
    const vsCol = h('div', { class: 'col', style: 'width:260px' });
    this.vsBody = h('div', { class: 'col-body' });
    vsCol.append(h('div', { class: 'col-head' }, h('h3', null, `Visual states (${m.visual.length})`)), this.vsBody);

    // Tree
    const search = h('input', { type: 'search', placeholder: 'Filter commands…' });
    search.addEventListener('input', debounce(() =>
    {
      this.filter = search.value.trim().toLowerCase();
      this.refreshRows();
    }, 120));
    const drawsOnly = h('input', { type: 'checkbox' });
    drawsOnly.addEventListener('change', () =>
    {
      this.drawsOnly = drawsOnly.checked;
      this.refreshRows();
    });
    const expandAll = h('button', { class: 'btn small', title: 'Expand all', on: { click: () => { for (const n of m.byKey.values()) if (n.children.length) this.expanded.add(n.key); this.refreshRows(); } } }, '+');
    const collapseAll = h('button', { class: 'btn small', title: 'Collapse to passes', on: { click: () => { this.expanded.clear(); for (const n of m.byKey.values()) if (n.kind === 'submit' || n.kind === 'cb') this.expanded.add(n.key); this.refreshRows(); } } }, '−');
    const treeCol = h('div', { class: 'col', style: 'flex:1;min-width:240px' });
    this.treeInner = h('div', { class: 'tree', style: 'position:relative' });
    this.treeBody = h('div', { class: 'col-body', tabIndex: 0 }, this.treeInner);
    treeCol.append(h('div', { class: 'col-head' }, h('div', { class: 'tree-tools' }, search, h('label', null, drawsOnly, 'draws only'), expandAll, collapseAll)), this.treeBody);
    this.treeBody.addEventListener('scroll', () => this.renderRows());
    this.treeBody.addEventListener('keydown', (e) => this.onKey(e));
    new ResizeObserver(() => this.renderRows()).observe(this.treeBody);

    // Details
    const detCol = h('div', { class: 'col', style: 'width:560px' });
    this.detailsBody = h('div', { class: 'col-body' });
    detCol.append(h('div', { class: 'col-head' }, h('h3', null, 'Details')), this.detailsBody);

    this.el = h('div', { class: 'view', style: 'flex:1' },
      vsCol, splitter(vsCol, 'vs', 'left'), treeCol, splitter(detCol, 'details', 'right', 300), detCol);

    this.buildVisualStates();
    this.refreshRows();

    const lastCanvas = [...m.visual].reverse().find((v) => isCanvasPass(ctx, v));
    const initial = lastCanvas ?? m.visual[m.visual.length - 1];
    if (initial) setTimeout(() => this.select(initial.node, true), 0);
    else if (m.flat.length) this.select(m.flat[0], false);
  }

  private buildVisualStates(): void
  {
    const m = this.ctx.model;
    clear(this.vsBody);
    if (!m.visual.length)
    {
      this.vsBody.append(h('div', { class: 'empty-state' }, 'No images in this capture.'));
      return;
    }
    let group: HTMLElement | null = null;
    let lastPass: any = null;
    for (const v of m.visual)
    {
      if (v.pass !== lastPass)
      {
        lastPass = v.pass;
        const head = h('div', { class: 'vs-pass-head', title: `${v.pass.label}\n${v.pass.node.hint ?? ''}`, on: { click: () => this.select(v.pass.node, true) } },
          `${v.pass.index + 1}. ${v.pass.label}`, v.pass.node.hint ? h('div', { class: 'sub' }, v.pass.node.hint) : null);
        group = h('div', { class: 'vs-pass' }, head);
        this.vsBody.append(group);
      }
      group!.append(this.card(v));
    }
  }

  private card(v: VisualState): HTMLElement
  {
    const snapId = v.snaps.c.find((x) => x !== null && x !== undefined) ?? v.snaps.d ?? null;
    const meta = snapId !== null ? this.ctx.cap.snapshots[snapId] : undefined;
    const imgWrap = h('div', { class: 'img' });
    if (meta) imgWrap.style.setProperty('--ar', `${meta.width} / ${meta.height}`);
    if (meta && !meta.missing)
    {
      const img = h('img', { alt: '', dataset: { snap: String(snapId) } });
      imgWrap.append(img);
      this.observer.observe(img);
    }
    else
    {
      imgWrap.append(h('div', { class: 'none' }, meta?.missing ?? 'not captured'));
    }
    const n = v.node;
    const extra = v.snaps.c.length > 1 ? `+${v.snaps.c.length - 1} targets` : '';
    const card = h('div', { class: 'vs-card', title: n.label, on: { click: () => this.select(n, true) } },
      imgWrap,
      h('div', { class: 'cap' },
        h('b', null, v.passEnd ? 'end' : n.drawNo ? `#${n.drawNo}` : '•'),
        h('span', { class: 'grow' }, v.passEnd ? 'End of pass' : n.kind === 'bundle' ? n.label : n.cmd?.n ?? n.label),
        extra ? h('span', null, extra) : null
      )
    );
    this.cards.set(n, card);
    return card;
  }

  // -- tree -----------------------------------------------------------------------

  private matches(n: TreeNode): boolean
  {
    if (this.drawsOnly && !(n.isDraw || n.isDispatch || n.snap)) return false;
    if (this.filter && !(`${n.label} ${n.hint ?? ''}`.toLowerCase().includes(this.filter))) return false;
    return true;
  }

  private refreshRows(): void
  {
    const out: TreeNode[] = [];
    const filtering = !!this.filter || this.drawsOnly;
    const visit = (n: TreeNode): boolean =>
    {
      // Returns whether n (or a descendant) is visible under the filter.
      if (!filtering)
      {
        out.push(n);
        if (this.expanded.has(n.key)) n.children.forEach(visit);
        return true;
      }
      const start = out.length;
      out.push(n);
      let any = false;
      for (const c of n.children) any = visit(c) || any;
      if (any || this.matches(n)) return true;
      out.length = start;
      return false;
    };
    this.ctx.model.root.children.forEach(visit);
    this.rows = out;
    this.treeInner.style.height = `${out.length * ROW_H + 40}px`;
    this.renderRows(true);
  }

  private renderRows(force = false): void
  {
    const top = this.treeBody.scrollTop;
    const hgt = this.treeBody.clientHeight || 800;
    const first = Math.max(0, Math.floor(top / ROW_H) - 10);
    const last = Math.min(this.rows.length, Math.ceil((top + hgt) / ROW_H) + 10);
    const key = `${first}:${last}:${this.rows.length}`;
    if (!force && this.treeInner.dataset.range === key) return;
    this.treeInner.dataset.range = key;
    clear(this.treeInner);
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) frag.append(this.row(this.rows[i], i));
    this.treeInner.append(frag);
  }

  private row(n: TreeNode, i: number): HTMLElement
  {
    const hasKids = n.children.length > 0;
    const open = this.expanded.has(n.key) || (!!this.filter || this.drawsOnly);
    const cls = ['row', `k-${n.kind}`];
    if (n.isDraw) cls.push('draw');
    if (n.isDispatch) cls.push('dispatch');
    if (n.kind === 'cmd' && !n.isDraw && !n.isDispatch && !n.snap) cls.push('dim');
    if (n === this.selected) cls.push('selected');
    const twist = h('span', { class: 'twist' }, hasKids ? (open ? '▼' : '▶') : '');
    if (hasKids)
    {
      twist.addEventListener('click', (e) =>
      {
        e.stopPropagation();
        this.toggle(n);
      });
    }
    const el = h('div', {
      class: cls.join(' '),
      style: `position:absolute;left:0;right:0;top:${i * ROW_H}px;padding-left:${n.depth * 14 + 4}px`,
      on: {
        click: () => this.select(n, false),
        dblclick: () => hasKids && this.toggle(n)
      }
    },
    twist,
    h('span', { class: 'idx' }, n.drawNo ? `#${n.drawNo}` : ''),
    h('span', { class: 'label' }, n.label),
    n.snap ? h('span', { class: 'thumb', title: 'has an image' }) : null,
    n.hint ? h('span', { class: 'hint' }, `  ${n.hint}`) : null
    );
    return el;
  }

  private toggle(n: TreeNode): void
  {
    if (this.expanded.has(n.key)) this.expanded.delete(n.key);
    else this.expanded.add(n.key);
    this.refreshRows();
  }

  private onKey(e: KeyboardEvent): void
  {
    if (!this.rows.length) return;
    let i = this.selected ? this.rows.indexOf(this.selected) : -1;
    if (e.key === 'ArrowDown') i = Math.min(this.rows.length - 1, i + 1);
    else if (e.key === 'ArrowUp') i = Math.max(0, i - 1);
    else if (e.key === 'ArrowRight' && this.selected?.children.length)
    {
      this.expanded.add(this.selected.key);
      this.refreshRows();
      e.preventDefault();
      return;
    }
    else if (e.key === 'ArrowLeft' && this.selected)
    {
      if (this.expanded.has(this.selected.key) && this.selected.children.length)
      {
        this.expanded.delete(this.selected.key);
        this.refreshRows();
      }
      else if (this.selected.parent && this.selected.parent.kind !== 'root') this.select(this.selected.parent, true);
      e.preventDefault();
      return;
    }
    else if (e.key === 'n' || e.key === 'p')
    {
      const draws = this.ctx.model.draws;
      const cur = this.selected?.drawNo ?? 0;
      const next = e.key === 'n' ? draws.find((d) => (d.drawNo ?? 0) > cur) : [...draws].reverse().find((d) => (d.drawNo ?? 0) < cur);
      if (next) this.select(next, true);
      return;
    }
    else return;
    e.preventDefault();
    if (i >= 0) this.select(this.rows[i], true);
  }

  select(n: TreeNode, scroll: boolean): void
  {
    // Make sure ancestors are expanded so the row exists.
    for (let p = n.parent; p && p.kind !== 'root'; p = p.parent)
    {
      if (!this.expanded.has(p.key))
      {
        this.expanded.add(p.key);
        this.refreshRowsSoon = true;
      }
    }
    const prevCard = this.selected ? this.cards.get(this.selected) : null;
    prevCard?.classList.remove('selected');
    this.selected = n;
    if (this.refreshRowsSoon)
    {
      this.refreshRowsSoon = false;
      this.refreshRows();
    }
    let idx = this.rows.indexOf(n);
    if (idx < 0 && (this.filter || this.drawsOnly))
    {
      this.filter = '';
      this.drawsOnly = false;
      this.refreshRows();
      idx = this.rows.indexOf(n);
    }
    if (scroll && idx >= 0)
    {
      const top = idx * ROW_H;
      const b = this.treeBody;
      if (top < b.scrollTop + 20 || top > b.scrollTop + b.clientHeight - 40) b.scrollTop = top - b.clientHeight / 3;
    }
    this.renderRows(true);

    const card = this.cards.get(n);
    if (card)
    {
      card.classList.add('selected');
      if (scroll)
      {
        const r = card.getBoundingClientRect();
        const pr = this.vsBody.getBoundingClientRect();
        if (r.top < pr.top || r.bottom > pr.bottom) card.scrollIntoView({ block: 'center' });
      }
    }

    clear(this.detailsBody);
    try
    {
      this.detailsBody.append(renderDetails(this.ctx, n));
    }
    catch (err: any)
    {
      console.error(err);
      this.detailsBody.append(h('div', { class: 'details' }, h('div', { class: 'note' }, `Could not render details: ${err?.message ?? err}`)));
    }
    this.detailsBody.scrollTop = 0;
  }

  private refreshRowsSoon = false;

  focus(): void
  {
    this.treeBody.focus();
  }
}

function isCanvasPass(ctx: Ctx, v: VisualState): boolean
{
  const d = v.pass.begin.a?.[0];
  for (const a of d?.colorAttachments ?? [])
  {
    for (const ref of [a?.view, a?.resolveTarget])
    {
      const view = ctx.obj(ref);
      const tex = view?.type === 'GPUTexture' ? view : ctx.obj(view?.texture);
      if (tex?.canvasContext) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------

const RES_ORDER = [
  'GPUTexture', 'GPUBuffer', 'GPURenderPipeline', 'GPUComputePipeline', 'GPUShaderModule', 'GPUBindGroup', 'GPUSampler',
  'GPUTextureView', 'GPUBindGroupLayout', 'GPUPipelineLayout', 'GPURenderBundle', 'GPUQuerySet', 'GPUExternalTexture',
  'GPUCanvasContext', 'GPUDevice', 'GPUAdapter', 'GPUQueue'
];

export class ResourcesView
{
  el: HTMLElement;
  private list: HTMLElement;
  private body: HTMLElement;
  private selected: number | null = null;
  private filter = '';
  private collapsed = new Set<string>(['GPUTextureView', 'GPUQueue']);

  constructor(private ctx: Ctx)
  {
    const search = h('input', { type: 'search', placeholder: 'Filter…', style: 'flex:1;background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:2px 6px' });
    search.addEventListener('input', debounce(() =>
    {
      this.filter = search.value.trim().toLowerCase();
      this.renderList();
    }, 120));
    const left = h('div', { class: 'col', style: 'width:340px' });
    this.list = h('div', { class: 'col-body res-list' });
    left.append(h('div', { class: 'col-head' }, search), this.list);
    const right = h('div', { class: 'col', style: 'flex:1' });
    this.body = h('div', { class: 'col-body', style: 'padding:12px 16px 40px' });
    right.append(h('div', { class: 'col-head' }, h('h3', null, 'Object')), this.body);
    this.el = h('div', { class: 'view' }, left, splitter(left, 'res', 'left'), right);
    this.renderList();
    this.body.append(h('div', { class: 'empty-state' }, 'Select an object.'));
  }

  private renderList(): void
  {
    clear(this.list);
    const groups = new Map<string, any[]>();
    for (const o of Object.values(this.ctx.cap.objects))
    {
      if (this.filter && !`${o.type} ${o.label ?? ''} #${o.id} ${o.format ?? ''}`.toLowerCase().includes(this.filter)) continue;
      const list = groups.get(o.type) ?? [];
      list.push(o);
      groups.set(o.type, list);
    }
    const types = [...groups.keys()].sort((a, b) => (RES_ORDER.indexOf(a) + 1 || 99) - (RES_ORDER.indexOf(b) + 1 || 99));
    for (const t of types)
    {
      const items = groups.get(t)!.sort((a, b) => a.id - b.id);
      const collapsed = this.collapsed.has(t) && !this.filter;
      this.list.append(h('div', {
        class: 'grp',
        on: { click: () => { if (this.collapsed.has(t)) this.collapsed.delete(t); else this.collapsed.add(t); this.renderList(); } }
      }, h('span', null, `${collapsed ? '▶' : '▼'} ${shortType(t)}`), h('span', null, String(items.length))));
      if (collapsed) continue;
      for (const o of items)
      {
        const sub = o.type === 'GPUTexture' ? `${o.format} ${o.width}×${o.height}` : o.type === 'GPUBuffer' ? fmtBytes(o.size) : '';
        const item = h('div', {
          class: `item${o.id === this.selected ? ' selected' : ''}`,
          on: { click: () => this.show(o.id) }
        }, o.type === 'GPUTexture' ? this.thumb(o.id) : null, h('span', null, o.label ? `"${o.label}"` : `#${o.id}`), sub ? h('span', { class: 'sub' }, sub) : null);
        this.list.append(item);
      }
    }
  }

  private thumb(texId: number): HTMLElement | null
  {
    const entry = Object.entries(this.ctx.cap.snapshots).reverse().find(([, s]) => s.texture === texId && !s.missing);
    const img = h('img', { alt: '' });
    if (entry) this.ctx.store.image(entry[0]).then((u) => { if (u && u.startsWith('data:image/')) img.src = u; });
    return img;
  }

  show(id: number): void
  {
    this.selected = id;
    clear(this.body);
    this.body.append(renderObject(this.ctx, id));
    for (const el of this.list.querySelectorAll('.item.selected')) el.classList.remove('selected');
    this.renderList();
  }
}

// ---------------------------------------------------------------------------

export function infoView(ctx: Ctx): HTMLElement
{
  const cap = ctx.cap;
  const m = cap.meta;
  const s = m.stats;
  const page = h('div', { class: 'info-page' });
  const stat = (n: number | string, l: string, title?: string) => h('div', { class: 'stat', title }, h('div', { class: 'n' }, String(n)), h('div', { class: 'l' }, l));
  const geometry = stat('…', 'geometry vertices', 'Vertices of the geometries drawn. A mesh drawn in two passes counts twice.');
  const total = stat('…', 'total drawn vertices', 'Geometry vertices that include instance count. A mesh drawn in two passes counts twice.');
  const vertexNote = h('div', { class: 'note', style: 'margin-top:8px' });
  computeVertexStats(ctx).then((v) =>
  {
    geometry.querySelector('.n')!.textContent = v.geometry.toLocaleString();
    total.querySelector('.n')!.textContent = v.total.toLocaleString();
    const notes: string[] = [];
    if (v.estimated) notes.push(`${v.estimated} indexed draw${v.estimated === 1 ? '' : 's'} counted by index count (their index data wasn’t captured).`);
    if (v.unknown) notes.push(`${v.unknown} indirect draw${v.unknown === 1 ? '' : 's'} not counted (arguments not captured).`);
    vertexNote.textContent = notes.join(' ');
  }, (e) =>
  {
    vertexNote.textContent = `Could not count vertices: ${e?.message ?? e}`;
  });
  page.append(
    h('h2', null, 'Frame'),
    h('div', { class: 'stats' },
      stat(s.draws ?? 0, 'draws'),
      geometry,
      total,
      stat(s.dispatches ?? 0, 'dispatches'),
      stat(s.renderPasses ?? 0, 'render passes'),
      stat(s.computePasses ?? 0, 'compute passes'),
      stat(s.submits ?? 0, 'submits'),
      stat(s.commandBuffers ?? 0, 'command buffers'),
      stat(s.snapshots ?? 0, 'images'),
      stat(fmtBytes(s.bufferBytes ?? 0), 'buffer contents copied', 'Bytes of buffer data the capture copied (uniform, storage, vertex, index and indirect buffers), so the viewer can show their contents.'),
      stat(`${Math.round(m.durationMs)} ms`, 'recording time')
    ),
    vertexNote
  );
  if (m.warnings.length)
  {
    page.append(h('h2', null, 'Warnings'), h('ul', { class: 'warnings' }, m.warnings.map((w) => h('li', null, w))));
  }
  page.append(h('h2', null, 'Page'), kv([
    ['URL', m.url],
    ['Title', m.title],
    ['Captured', new Date(m.time).toLocaleString()],
    ['Started by', m.trigger],
    ['Browser', m.userAgent]
  ]));

  const devices = Object.values(cap.objects).filter((o: any) => o.type === 'GPUDevice');
  for (const d of devices)
  {
    const adapter = ctx.obj(d.adapter);
    const info = d.adapterInfo ?? adapter?.info;
    page.append(h('h2', null, `Device #${d.id}${d.label ? ` "${d.label}"` : ''}`));
    if (info) page.append(kv(Object.entries(info).filter(([, v]) => v !== '' && v !== undefined).map(([k, v]) => [k, typeof v === 'object' ? ptree(ctx, v) : String(v)])));
    page.append(h('div', { style: 'margin-top:10px' }, h('div', { class: 'feature-list' }, (d.features ?? []).map((f: string) => h('span', { class: 'chip' }, f)))));
    page.append(h('details', { style: 'margin-top:10px' }, h('summary', { style: 'cursor:pointer;color:var(--muted)' }, 'Device limits'), h('div', { style: 'max-width:520px' }, limitsTable(d.limits))));
  }

  const ctxs = Object.values(cap.objects).filter((o: any) => o.type === 'GPUCanvasContext');
  if (ctxs.length)
  {
    page.append(h('h2', null, 'Canvases'));
    for (const c of ctxs)
    {
      page.append(h('div', { style: 'margin-bottom:10px' }, refLink(ctx, { $ref: c.id }), kv([
        ['Canvas', c.canvas ? `${c.canvas.tag}${c.canvas.id ? ` #${c.canvas.id}` : ''}${c.canvas.className ? ` .${c.canvas.className}` : ''} ${c.canvas.width}×${c.canvas.height}` : ''],
        ['Format', c.config?.format ?? ''],
        ['Alpha mode', c.config?.alphaMode ?? 'opaque'],
        ['Color space', c.config?.colorSpace ?? 'srgb'],
        ['Tone mapping', c.config?.toneMapping ? ptree(ctx, c.config.toneMapping) : '']
      ])));
    }
  }

  page.append(h('h2', null, 'Capture settings'), h('div', { style: 'max-width:520px' }, ptree(ctx, m.settings)));
  page.append(h('h2', null, 'Keyboard'), kv([
    ['↑ / ↓', 'previous / next row in the command list'],
    ['← / →', 'collapse / expand'],
    ['n / p', 'next / previous draw'],
    ['Esc', 'close dialogs and the inspector']
  ]));
  return page;
}

export { buildModel, objectTitle };
