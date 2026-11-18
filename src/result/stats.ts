// Frame-wide vertex counts, computed from the recorded draw arguments (and, for indexed or
// indirect draws, from the captured index / indirect buffers).

import type { CmdJSON } from '../shared/protocol';
import { refId, type Ctx } from './ctx';
import type { TreeNode } from './model';
import { loadBufferSnapshot, viewAt } from './widgets';

export interface VertexStats
{
  /** Vertices of the geometries drawn (unique vertices for indexed draws), summed over draws. */
  geometry: number;
  /** geometry × instance count. */
  total: number;
  /** Indexed draws whose index data wasn't captured: counted by index count instead. */
  estimated: number;
  /** Indirect draws whose arguments weren't captured: not counted. */
  unknown: number;
}

interface DrawArgs
{
  count: number;
  instances: number;
  firstIndex?: number;
}

const uniqueCache = new Map<string, number | null>();

/** Number of distinct vertices referenced by `count` indices starting at `firstIndex`. */
async function uniqueVertices(ctx: Ctx, node: TreeNode, firstIndex: number, count: number): Promise<number | null>
{
  const ib = node.cmd?.draw?.state?.indexBuffer;
  const bufId = refId(ib?.buffer);
  const snapId = bufId !== undefined ? node.pass?.json.bufSnaps[String(bufId)] : undefined;
  if (!ib || snapId === undefined) return null;
  const sz = ib.format === 'uint32' ? 4 : 2;
  const key = `${snapId}:${ib.offset}:${firstIndex}:${count}:${sz}`;
  if (uniqueCache.has(key)) return uniqueCache.get(key)!;

  const data = await loadBufferSnapshot(ctx, snapId);
  const dv = data ? viewAt(data, ib.offset + firstIndex * sz, count * sz) : null;
  let result: number | null = null;
  if (dv && dv.byteLength >= count * sz)
  {
    const pipeline = ctx.obj(node.cmd?.draw?.state?.pipeline);
    const strip = String(pipeline?.desc?.primitive?.topology ?? '').endsWith('strip');
    const restart = sz === 4 ? 0xffffffff : 0xffff;
    const read = sz === 4 ? (i: number) => dv.getUint32(i * 4, true) : (i: number) => dv.getUint16(i * 2, true);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < count; i++)
    {
      const v = read(i);
      if (strip && v === restart) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (max < min) result = 0;
    else if (max - min < 1 << 26)
    {
      const seen = new Uint8Array(max - min + 1);
      let n = 0;
      for (let i = 0; i < count; i++)
      {
        const v = read(i);
        if (strip && v === restart) continue;
        if (!seen[v - min])
        {
          seen[v - min] = 1;
          n++;
        }
      }
      result = n;
    }
    else
    {
      const set = new Set<number>();
      for (let i = 0; i < count; i++) set.add(read(i));
      result = set.size;
    }
  }
  uniqueCache.set(key, result);
  return result;
}

/** Arguments of an indirect draw, read from the captured indirect buffer. */
async function indirectArgs(ctx: Ctx, node: TreeNode, c: CmdJSON): Promise<DrawArgs[] | null>
{
  const a = c.a ?? [];
  const bufId = refId(a[0]);
  const snapId = bufId !== undefined ? node.pass?.json.bufSnaps[String(bufId)] : undefined;
  const data = await loadBufferSnapshot(ctx, snapId);
  if (!data) return null;
  const indexed = c.n.includes('Indexed');
  const stride = indexed ? 20 : 16;
  let draws = 1;
  if (c.n.startsWith('multiDraw'))
  {
    draws = Math.max(0, Number(a[2]) || 0);
    const countRef = refId(a[3]);
    if (countRef !== undefined)
    {
      const countData = await loadBufferSnapshot(ctx, node.pass?.json.bufSnaps[String(countRef)]);
      const cv = countData ? viewAt(countData, Number(a[4]) || 0, 4) : null;
      if (!cv || cv.byteLength < 4) return null;
      draws = Math.min(draws, cv.getUint32(0, true));
    }
  }
  const out: DrawArgs[] = [];
  for (let d = 0; d < draws; d++)
  {
    const dv = viewAt(data, (Number(a[1]) || 0) + d * stride, stride);
    if (!dv || dv.byteLength < stride) return null;
    out.push(indexed
      ? { count: dv.getUint32(0, true), instances: dv.getUint32(4, true), firstIndex: dv.getUint32(8, true) }
      : { count: dv.getUint32(0, true), instances: dv.getUint32(4, true) });
  }
  return out;
}

export async function computeVertexStats(ctx: Ctx): Promise<VertexStats>
{
  const stats: VertexStats = { geometry: 0, total: 0, estimated: 0, unknown: 0 };
  for (const node of ctx.model.draws)
  {
    const c = node.cmd;
    if (!node.isDraw || !c) continue;
    const a = c.a ?? [];
    let list: DrawArgs[] | null;
    const indexed = c.n.includes('Indexed');
    if (c.n === 'draw') list = [{ count: Number(a[0]) || 0, instances: a[1] ?? 1 }];
    else if (c.n === 'drawIndexed') list = [{ count: Number(a[0]) || 0, instances: a[1] ?? 1, firstIndex: Number(a[2]) || 0 }];
    else list = await indirectArgs(ctx, node, c);

    if (!list)
    {
      stats.unknown++;
      continue;
    }
    for (const d of list)
    {
      const instances = Number(d.instances) || 0;
      if (!d.count || !instances) continue;
      let vertices = d.count;
      if (indexed)
      {
        const u = await uniqueVertices(ctx, node, d.firstIndex ?? 0, d.count);
        if (u === null) stats.estimated++;
        else vertices = u;
      }
      stats.geometry += vertices;
      stats.total += vertices * instances;
    }
  }
  return stats;
}
