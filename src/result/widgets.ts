// Reusable pieces: object links, property trees, image boxes, buffer viewers.

import { BUFFER_USAGE_FLAGS, SHADER_STAGE_FLAGS, TEXTURE_USAGE_FLAGS, flagNames } from '../shared/formats';
import { refId, type Ctx } from './ctx';
import { decodeType, type Field } from './decode';
import { clear, fmtBytes, fmtNum, h, type Child } from './dom';
import { shortType } from './model';

export function refLink(ctx: Ctx, ref: any, opts: { short?: boolean } = {}): HTMLElement
{
  const id = refId(ref);
  if (id === undefined) return h('span', { class: 'ptree' }, h('span', { class: 'nul' }, String(ref)));
  const o = ctx.cap.objects[id];
  const type = o ? shortType(o.type) : 'object';
  return h('span', {
    class: 'ref',
    title: `${o?.type ?? 'object'} #${id}${o?.label ? ` "${o.label}"` : ''}`,
    on: {
      click: (e: MouseEvent) =>
      {
        e.stopPropagation();
        ctx.openObject(id);
      }
    }
  },
  opts.short ? null : `${type} `,
  o?.label ? h('span', { class: 'rl' }, `"${o.label}"`) : null,
  ` #${id}`);
}

/** Generic JSON-ish value view, with refs as links. */
export function ptree(ctx: Ctx, v: any, depth = 0): HTMLElement
{
  const wrap = h('div', { class: 'ptree' });
  wrap.append(pvalue(ctx, v, depth));
  return wrap;
}

function pvalue(ctx: Ctx, v: any, depth: number): Node
{
  if (v === null || v === undefined) return h('span', { class: 'nul' }, String(v));
  if (typeof v === 'string') return h('span', { class: 's' }, JSON.stringify(v.length > 2000 ? `${v.slice(0, 2000)}…` : v));
  if (typeof v === 'number') return h('span', { class: 'n' }, fmtNum(v));
  if (typeof v === 'boolean') return h('span', { class: 'b' }, String(v));
  if (typeof v !== 'object') return document.createTextNode(String(v));
  if (refId(v) !== undefined) return refLink(ctx, v);
  if (v.$bytes !== undefined) return h('span', { class: 'nul' }, `${v.$type ?? 'bytes'} (${fmtBytes(v.$bytes)})`);
  if (v.$dom !== undefined) return h('span', { class: 'nul' }, `${v.$dom}${v.width !== undefined ? ` ${v.width}×${v.height}` : ''}${v.src ? ` ${v.src}` : ''}`);
  const entries: [string, any][] = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
  if (!entries.length) return h('span', { class: 'nul' }, Array.isArray(v) ? '[]' : '{}');
  if (Array.isArray(v) && v.every((x) => typeof x === 'number') && v.length <= 16)
  {
    return h('span', { class: 'n' }, `[${v.map(fmtNum).join(', ')}]`);
  }
  if (depth > 8) return h('span', { class: 'nul' }, '…');
  const nest = h('div', { class: 'pt-nest' });
  for (const [k, x] of entries)
  {
    let val: Node;
    if (k === 'usage' && typeof x === 'number') val = h('span', { class: 'n' }, `${x}`);
    else val = pvalue(ctx, x, depth + 1);
    nest.append(h('div', { class: 'pt-row' }, h('span', { class: 'pt-k' }, `${k}:`), h('span', { class: 'pt-v' }, val)));
  }
  return nest;
}

export function usageText(type: 'buffer' | 'texture' | 'stage', v: number): string
{
  return flagNames(v, type === 'buffer' ? BUFFER_USAGE_FLAGS : type === 'texture' ? TEXTURE_USAGE_FLAGS : SHADER_STAGE_FLAGS);
}

// ---------------------------------------------------------------------------
// Images

export function imageBox(ctx: Ctx, snapId: number | null | undefined, opts: { size?: 'big' | 'small' | 'tiny'; caption?: Child; title?: string } = {}): HTMLElement
{
  const size = opts.size ?? 'small';
  const meta = snapId !== null && snapId !== undefined ? ctx.cap.snapshots[snapId] : undefined;
  const frame = h('div', { class: 'frame' });
  const box = h('div', { class: `imgbox ${size}` }, frame);
  if (meta) box.style.setProperty('--ar', `${meta.width} / ${meta.height}`);
  if (!meta || meta.missing)
  {
    frame.append(h('div', { class: 'none' }, meta?.missing ?? 'no image'));
    frame.style.cursor = 'default';
  }
  else
  {
    const img = h('img', { alt: '', decoding: 'async' });
    frame.append(img);
    ctx.store.image(snapId!).then((url) =>
    {
      if (url && url.startsWith('data:image/')) img.src = url;
      else frame.replaceChildren(h('div', { class: 'none' }, 'image not stored'));
    });
    frame.addEventListener('click', () => ctx.openImage(snapId!, opts.title));
  }
  if (opts.caption !== undefined) box.append(h('div', { class: 'cap' }, opts.caption));
  else if (meta) box.append(h('div', { class: 'cap' }, snapCaption(meta)));
  return box;
}

export function snapCaption(meta: any): string
{
  const parts = [meta.format, `${meta.srcWidth}×${meta.srcHeight}`];
  if (meta.sampleCount > 1) parts.push(`${meta.sampleCount}× MSAA (sample 0)`);
  if (meta.mip) parts.push(`mip ${meta.mip}`);
  if (meta.layer) parts.push(`layer ${meta.layer}`);
  if (meta.kind === 'depth' && meta.depthMin !== undefined) parts.push(`depth ${fmtNum(meta.depthMin)} … ${fmtNum(meta.depthMax)}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Buffers

export interface BufferData
{
  ranges: { offset: number; bytes: Uint8Array }[];
  missing?: string;
}

const bufferCache = new Map<number, Promise<BufferData | null>>();

export function loadBufferSnapshot(ctx: Ctx, bufSnapId: number | undefined): Promise<BufferData | null>
{
  if (bufSnapId === undefined) return Promise.resolve(null);
  let p = bufferCache.get(bufSnapId);
  if (!p)
  {
    const meta = ctx.cap.bufferSnapshots[bufSnapId];
    p = (async () =>
    {
      if (!meta) return null;
      const ranges: BufferData['ranges'] = [];
      for (const r of meta.ranges)
      {
        const bytes = await ctx.store.buffer(r.key);
        if (bytes) ranges.push({ offset: r.offset, bytes });
      }
      return { ranges, missing: meta.missing };
    })();
    bufferCache.set(bufSnapId, p);
  }
  return p;
}

/** A DataView starting at buffer offset `offset` (as far as the captured range goes). */
export function viewAt(data: BufferData, offset: number, length: number): DataView | null
{
  for (const r of data.ranges)
  {
    if (offset >= r.offset && offset < r.offset + r.bytes.byteLength)
    {
      const start = offset - r.offset;
      const len = Math.min(length, r.bytes.byteLength - start);
      return new DataView(r.bytes.buffer, r.bytes.byteOffset + start, len);
    }
  }
  return null;
}

function valueText(f: Field): Child
{
  if (f.missing) return h('span', { class: 'nul' }, 'not captured');
  if (f.matrix)
  {
    const rows = f.matrix[0]?.length ?? 0;
    const t = h('table', { class: 'mat' });
    for (let r = 0; r < rows; r++)
    {
      t.append(h('tr', null, f.matrix.map((col) => h('td', null, fmtNum(col[r])))));
    }
    return t;
  }
  if (f.values)
  {
    const v = f.values.map((x) => (typeof x === 'number' ? fmtNum(x) : x));
    return v.length === 1 ? v[0] : `(${v.join(', ')})`;
  }
  return '';
}

export function fieldTable(root: Field): HTMLElement
{
  const t = h('table', { class: 'struct' });
  const add = (f: Field, depth: number) =>
  {
    t.append(h('tr', null,
      h('td', { class: 'n', style: `padding-left:${depth * 14}px` }, f.name),
      h('td', { class: 't' }, f.type),
      h('td', { class: 'o' }, `+${f.offset}`),
      h('td', { class: 'val' }, valueText(f))
    ));
    for (const c of f.children ?? []) add(c, depth + 1);
    if (f.truncated) t.append(h('tr', null, h('td', { class: 'n nul', style: `padding-left:${(depth + 1) * 14}px`, colSpan: 4 }, `… ${f.truncated} more`)));
  };
  if (root.children && !root.values && !root.matrix) for (const c of root.children) add(c, 0);
  else add(root, 0);
  return t;
}

export function decodeStruct(type: any, data: BufferData, offset: number, size: number, name: string): Field | null
{
  const dv = viewAt(data, offset, size || type?.size || 256);
  if (!dv) return null;
  return decodeType(type, dv, 0, name);
}

type RawFmt = 'f32' | 'u32' | 'i32' | 'hex';

/** Raw buffer viewer with a format switch. */
export function rawViewer(data: BufferData, offset: number, size: number, initial: RawFmt = 'f32'): HTMLElement
{
  let fmt: RawFmt = initial;
  let limit = 1024;
  const out = h('div', { class: 'hexview' });
  const seg = h('span', { class: 'seg' });
  const more = h('button', { class: 'btn small', on: { click: () => { limit *= 4; render(); } } }, 'Show more');
  const render = () =>
  {
    for (const b of seg.children) (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.f === fmt);
    const dv = viewAt(data, offset, size);
    if (!dv)
    {
      out.textContent = 'This range was not captured.';
      more.hidden = true;
      return;
    }
    const lines: string[] = [];
    const n = Math.floor(dv.byteLength / 4);
    const count = Math.min(n, limit);
    if (fmt === 'hex')
    {
      for (let i = 0; i < Math.min(dv.byteLength, limit * 4); i += 16)
      {
        const bytes: string[] = [];
        for (let j = i; j < Math.min(i + 16, dv.byteLength); j++) bytes.push(dv.getUint8(j).toString(16).padStart(2, '0'));
        lines.push(`${(offset + i).toString(16).padStart(8, '0')}  ${bytes.join(' ')}`);
      }
    }
    else
    {
      for (let i = 0; i < count; i += 4)
      {
        const vals: string[] = [];
        for (let j = i; j < Math.min(i + 4, count); j++)
        {
          const o = j * 4;
          const v = fmt === 'f32' ? dv.getFloat32(o, true) : fmt === 'u32' ? dv.getUint32(o, true) : dv.getInt32(o, true);
          vals.push((fmt === 'f32' ? fmtNum(v) : String(v)).padStart(13));
        }
        lines.push(`${String(offset + i * 4).padStart(8)}: ${vals.join(' ')}`);
      }
    }
    out.textContent = lines.join('\n');
    more.hidden = n <= limit;
  };
  for (const f of ['f32', 'u32', 'i32', 'hex'] as RawFmt[])
  {
    seg.append(h('button', { dataset: { f }, on: { click: () => { fmt = f; render(); } } }, f));
  }
  render();
  return h('div', null, h('div', { class: 'toolbar' }, seg, h('span', { class: 'chip' }, `${fmtBytes(size)} @ ${offset}`), more), out);
}

/** Async placeholder that fills itself once `p` resolves. */
export function later(p: Promise<Child>, placeholder = 'Loading…'): HTMLElement
{
  const el = h('div', null, h('span', { class: 'chip' }, placeholder));
  p.then((c) =>
  {
    clear(el);
    if (c !== null && c !== undefined && c !== false) el.append(...(Array.isArray(c) ? c : [c]).map((x) => (x instanceof Node ? x : document.createTextNode(String(x)))));
  }, (e) =>
  {
    clear(el);
    el.append(h('span', { class: 'note' }, `Error: ${e?.message ?? e}`));
  });
  return el;
}

export function samplerSummary(desc: any): string
{
  if (!desc) return 'default sampler';
  const f = `${desc.magFilter ?? 'nearest'}/${desc.minFilter ?? 'nearest'}/${desc.mipmapFilter ?? 'nearest'}`;
  const a = [desc.addressModeU ?? 'clamp-to-edge', desc.addressModeV ?? 'clamp-to-edge', desc.addressModeW ?? 'clamp-to-edge'];
  const addr = a.every((x) => x === a[0]) ? a[0] : a.join(', ');
  const parts = [`filter ${f}`, `address ${addr}`];
  if (desc.compare) parts.push(`compare ${desc.compare}`);
  if (desc.maxAnisotropy && desc.maxAnisotropy > 1) parts.push(`aniso ${desc.maxAnisotropy}`);
  if (desc.lodMinClamp || (desc.lodMaxClamp !== undefined && desc.lodMaxClamp !== 32)) parts.push(`lod ${desc.lodMinClamp ?? 0}…${desc.lodMaxClamp ?? 32}`);
  return parts.join(' · ');
}

export function textureOfView(ctx: Ctx, viewRef: any): any
{
  const o = ctx.obj(viewRef);
  if (!o) return null;
  if (o.type === 'GPUTexture') return o;
  return ctx.obj(o.texture);
}

export function texSummary(t: any): string
{
  if (!t) return '';
  const parts = [t.format, `${t.width}×${t.height}${t.depthOrArrayLayers > 1 ? `×${t.depthOrArrayLayers}` : ''}`];
  if (t.dimension && t.dimension !== '2d') parts.push(t.dimension);
  if (t.mipLevelCount > 1) parts.push(`${t.mipLevelCount} mips`);
  if (t.sampleCount > 1) parts.push(`${t.sampleCount}× MSAA`);
  if (t.canvasContext) parts.push('canvas');
  return parts.join(' · ');
}
