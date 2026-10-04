// Frame recorder: owns the capture state machine, the per-encoder / per-pass command logs,
// the pass splitting that produces per-draw images, and the final readback + serialization.

import {
  DEFAULT_SETTINGS,
  type BufferSnapshotJSON,
  type CaptureJSON,
  type CaptureProgress,
  type CaptureResultMessage,
  type CaptureSettings,
  type DrawSnaps,
  type SnapshotJSON
} from '../shared/protocol';
import { hasDepthAspect, hasStencilAspect } from '../shared/formats';
import { BU, G, TU } from './gpu';
import { getInfo, idOf, infoOf, tagOf } from './registry';
import { bytesOf, clone, ser, toBase64 } from './serialize';
import {
  snapshotBuffer,
  snapshotView,
  viewInfo,
  type PendingBufferSnapshot,
  type PendingSnapshot
} from './snapshot';

const SNAPSHOT_MEMORY_LIMIT = 1536 * 1024 * 1024;
const MAX_CAPTURE_MS = 10000;

let internalErrors = 0;

/** Bugs in the instrumentation are logged, never thrown into the page. */
export function internalError(e: unknown): void
{
  if (internalErrors++ < 5) console.warn('[WebGPU Spector] internal error (the page keeps running):', e);
}

export interface Cmd
{
  i: number;
  n: string;
  o?: any;
  a?: any[];
  r?: any;
  st?: number;
  draw?: any;
  pass?: any;
  cbs?: (number | null)[];
  x?: any;
}

export const DRAW_METHODS = new Set(['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect', 'multiDrawIndirect', 'multiDrawIndexedIndirect']);
export const DISPATCH_METHODS = new Set(['dispatchWorkgroups', 'dispatchWorkgroupsIndirect']);

function normOffsets(args: any[]): number[]
{
  const d = args[2];
  if (!d) return [];
  if (args.length >= 5 && ArrayBuffer.isView(d))
  {
    return Array.from((d as Uint32Array).subarray(args[3] ?? 0, (args[3] ?? 0) + (args[4] ?? 0)));
  }
  try
  {
    return Array.from(d as Iterable<number>);
  }
  catch
  {
    return [];
  }
}

function indirectBytes(name: string, args: any[]): number
{
  switch (name)
  {
    case 'drawIndirect': return 16;
    case 'drawIndexedIndirect': return 20;
    case 'dispatchWorkgroupsIndirect': return 12;
    case 'multiDrawIndirect': return 16 * Math.max(1, Number(args[2]) || 1);
    case 'multiDrawIndexedIndirect': return 20 * Math.max(1, Number(args[2]) || 1);
    default: return 0;
  }
}

/** Records which bind groups / buffers a pass (or bundle) touched, for pass-end snapshots. */
class Usage
{
  bindGroups = new Map<GPUBindGroup, number[][]>();
  buffers = new Map<GPUBuffer, { offset: number; size: number }[]>();

  bindGroup(bg: GPUBindGroup, offsets: number[]): void
  {
    let list = this.bindGroups.get(bg);
    if (!list)
    {
      list = [];
      this.bindGroups.set(bg, list);
    }
    const key = offsets.join(',');
    if (!list.some((o) => o.join(',') === key)) list.push(offsets);
  }

  buffer(buf: GPUBuffer | null | undefined, offset: number, size?: number): void
  {
    if (!buf || tagOf(buf) !== 'GPUBuffer') return;
    let list = this.buffers.get(buf);
    if (!list)
    {
      list = [];
      this.buffers.set(buf, list);
    }
    list.push({ offset: offset || 0, size: size ?? Math.max(0, buf.size - (offset || 0)) });
  }

  merge(other: Usage): void
  {
    for (const [bg, list] of other.bindGroups) for (const o of list) this.bindGroup(bg, o);
    for (const [buf, list] of other.buffers) for (const r of list) this.buffer(buf, r.offset, r.size);
  }
}

// ---------------------------------------------------------------------------

export class EncoderRec
{
  id: number;
  label: string;
  cmds: Cmd[] = [];
  submitted = false;

  constructor(public encoder: GPUCommandEncoder, public device: GPUDevice, label: string | undefined)
  {
    this.id = idOf(encoder);
    this.label = label ?? '';
  }
}

/** Always-on recorder for render bundle encoders (bundles are usually built once and replayed). */
export class BundleRec
{
  cmds: Cmd[] = [];
  usage = new Usage();
  seq = 0;
  pipeline: any = null;
  bindGroups = new Map<number, { bg: any; offsets: number[] }>();
  vbs = new Map<number, { buffer: any; offset: number; size?: number }>();
  ib: any = null;
  draws = 0;

  constructor(public desc: any) {}

  invoke(name: string, args: any[]): void
  {
    const c: Cmd = { i: this.seq++, n: name };
    if (args.length) c.a = clone(args);
    switch (name)
    {
      case 'setPipeline':
        this.pipeline = args[0];
        break;
      case 'setBindGroup':
      {
        const offsets = normOffsets(args);
        if (args[1])
        {
          this.bindGroups.set(args[0], { bg: args[1], offsets });
          this.usage.bindGroup(args[1], offsets);
        }
        else this.bindGroups.delete(args[0]);
        c.a = [args[0], args[1], offsets];
        break;
      }
      case 'setVertexBuffer':
        if (args[1])
        {
          this.vbs.set(args[0], { buffer: args[1], offset: args[2] ?? 0, size: args[3] });
          this.usage.buffer(args[1], args[2] ?? 0, args[3]);
        }
        else this.vbs.delete(args[0]);
        break;
      case 'setIndexBuffer':
        this.ib = { buffer: args[0], format: args[1], offset: args[2] ?? 0, size: args[3] };
        this.usage.buffer(args[0], args[2] ?? 0, args[3]);
        break;
    }
    if (DRAW_METHODS.has(name))
    {
      this.draws++;
      if (name.includes('Indirect')) this.usage.buffer(args[0], args[1] ?? 0, indirectBytes(name, args));
      c.draw = { state: stateOf(this.pipeline, this.bindGroups, this.vbs, this.ib) };
    }
    this.cmds.push(c);
  }
}

function stateOf(pipeline: any, bindGroups: Map<number, any>, vbs: Map<number, any>, ib: any, extra?: any): any
{
  return {
    pipeline,
    bindGroups: [...bindGroups].sort((a, b) => a[0] - b[0]).map(([index, b]) => ({ index, bindGroup: b.bg, offsets: b.offsets })),
    vertexBuffers: [...vbs].sort((a, b) => a[0] - b[0]).map(([slot, v]) => ({ slot, buffer: v.buffer, offset: v.offset, size: v.size })),
    indexBuffer: ib ? { ...ib } : null,
    ...extra
  };
}

// ---------------------------------------------------------------------------

export class PassRec
{
  current: any;
  json: { kind: 'render' | 'compute'; cmds: Cmd[]; texSnaps: Record<string, number>; bufSnaps: Record<string, number>; endSnap?: DrawSnaps; split: boolean; notes: string[] };
  usage = new Usage();

  colors: any[] = [];
  ds: any = null;
  split = false;
  contDesc: any = null;
  finalDesc: any = null;
  needsFinal = false;

  pipeline: any = null;
  bindGroups = new Map<number, { bg: any; offsets: number[] }>();
  vbs = new Map<number, { buffer: any; offset: number; size?: number }>();
  ib: any = null;
  viewport: number[] | null = null;
  scissor: number[] | null = null;
  blend: any = null;
  stencil: number | null = null;
  debug: string[] = [];
  occlusion = false;
  pendingSnap: Cmd | null = null;
  drawCount = 0;
  lastSnappedDraw = 0;
  budgetNoted = false;

  constructor(public rec: Recorder, public kind: 'render' | 'compute', public enc: EncoderRec, public app: any)
  {
    this.current = app;
    this.json = { kind, cmds: [], texSnaps: {}, bufSnaps: {}, split: false, notes: [] };
  }

  note(msg: string): void
  {
    if (!this.json.notes.includes(msg)) this.json.notes.push(msg);
  }

  state(): any
  {
    if (this.kind === 'compute') return stateOf(this.pipeline, this.bindGroups, new Map(), null);
    return stateOf(this.pipeline, this.bindGroups, this.vbs, this.ib, {
      viewport: this.viewport,
      scissor: this.scissor,
      blendConstant: this.blend,
      stencilReference: this.stencil
    });
  }

  invoke(name: string, fn: (...a: any[]) => any, args: any[]): any
  {
    let c: Cmd;
    try
    {
      c = this.record(name, args);
    }
    catch (e)
    {
      internalError(e);
      c = { i: -1, n: name };
    }

    if (name === 'end') return this.end(fn, c);
    if (name === 'executeBundles') return this.executeBundles(fn, args, c);

    const ret = fn.apply(this.current, args);
    try
    {
      this.after(name, args, c);
    }
    catch (e)
    {
      internalError(e);
    }
    return ret;
  }

  private record(name: string, args: any[]): Cmd
  {
    const c = this.rec.cmd(name, null, args);
    this.json.cmds.push(c);

    switch (name)
    {
      case 'setPipeline':
        this.pipeline = args[0];
        break;
      case 'setBindGroup':
      {
        const offsets = normOffsets(args);
        if (args[1])
        {
          this.bindGroups.set(args[0], { bg: args[1], offsets });
          this.usage.bindGroup(args[1], offsets);
        }
        else this.bindGroups.delete(args[0]);
        c.a = [args[0], args[1], offsets];
        break;
      }
      case 'setVertexBuffer':
        if (args[1])
        {
          this.vbs.set(args[0], { buffer: args[1], offset: args[2] ?? 0, size: args[3] });
          this.usage.buffer(args[1], args[2] ?? 0, args[3]);
        }
        else this.vbs.delete(args[0]);
        break;
      case 'setIndexBuffer':
        this.ib = { buffer: args[0], format: args[1], offset: args[2] ?? 0, size: args[3] };
        this.usage.buffer(args[0], args[2] ?? 0, args[3]);
        break;
      case 'setViewport':
        this.viewport = Array.from(args).slice(0, 6);
        break;
      case 'setScissorRect':
        this.scissor = Array.from(args).slice(0, 4);
        break;
      case 'setBlendConstant':
        this.blend = clone(args[0]);
        break;
      case 'setStencilReference':
        this.stencil = args[0];
        break;
      case 'pushDebugGroup':
        this.debug.push(String(args[0]));
        break;
      case 'popDebugGroup':
        this.debug.pop();
        break;
      case 'beginOcclusionQuery':
        this.occlusion = true;
        break;
      case 'endOcclusionQuery':
        this.occlusion = false;
        break;
    }
    return c;
  }

  private after(name: string, args: any[], c: Cmd): void
  {
    const rec = this.rec;
    if (DRAW_METHODS.has(name) || DISPATCH_METHODS.has(name))
    {
      if (DRAW_METHODS.has(name))
      {
        rec.stats.draws++;
        this.drawCount++;
      }
      else rec.stats.dispatches++;
      c.draw = { state: this.state() };
      const st = rec.stack();
      if (st !== undefined) c.st = st;
      if (name.includes('Indirect')) this.usage.buffer(args[0], args[1] ?? 0, indirectBytes(name, args));
      if (this.kind === 'render') this.trySnap(c);
    }
    else if (name === 'endOcclusionQuery' && this.pendingSnap)
    {
      const p = this.pendingSnap;
      this.pendingSnap = null;
      this.trySnap(p);
    }
  }

  // -- render pass splitting ------------------------------------------------

  /** Builds the descriptors used to split this pass. Returns the descriptor for the first segment. */
  prepareSplit(desc: any): any | null
  {
    const colors = Array.from(desc.colorAttachments ?? [], (a: any) => a ?? null);
    const ds = desc.depthStencilAttachment ?? null;
    const views = [...colors.flatMap((a: any) => (a ? [a.view, a.resolveTarget] : [])), ds?.view].filter(Boolean);
    for (const v of views)
    {
      const vi = viewInfo(v);
      if (vi && vi.texture.usage & TU.TRANSIENT_ATTACHMENT)
      {
        this.note('Pass not split: it uses a transient attachment');
        return null;
      }
    }

    const pick = (a: any) => ({ view: a.view, resolveTarget: a.resolveTarget, depthSlice: a.depthSlice });
    const first: any = { ...desc };
    const cont: any = { label: desc.label, occlusionQuerySet: desc.occlusionQuerySet, maxDrawCount: desc.maxDrawCount };
    const fin: any = { ...cont };
    let needsFinal = false;

    first.colorAttachments = colors.map((a: any) => a && {
      ...pick(a),
      loadOp: a.loadOp,
      clearValue: a.clearValue,
      storeOp: 'store'
    });
    cont.colorAttachments = colors.map((a: any) => a && { ...pick(a), loadOp: 'load', storeOp: 'store' });
    fin.colorAttachments = colors.map((a: any) =>
    {
      if (!a) return null;
      if (a.storeOp !== 'store') needsFinal = true;
      return { ...pick(a), loadOp: 'load', storeOp: a.storeOp };
    });

    if (ds)
    {
      const vi = viewInfo(ds.view);
      const fmt = vi ? vi.texture.format : '';
      const hasD = hasDepthAspect(fmt);
      const hasS = hasStencilAspect(fmt);
      const base = { view: ds.view, depthReadOnly: ds.depthReadOnly, stencilReadOnly: ds.stencilReadOnly };
      const f: any = { ...base };
      const c: any = { ...base };
      const e: any = { ...base };
      if (hasD && !ds.depthReadOnly)
      {
        f.depthLoadOp = ds.depthLoadOp;
        f.depthClearValue = ds.depthClearValue;
        f.depthStoreOp = 'store';
        c.depthLoadOp = 'load';
        c.depthStoreOp = 'store';
        e.depthLoadOp = 'load';
        e.depthStoreOp = ds.depthStoreOp;
        if (ds.depthStoreOp !== 'store') needsFinal = true;
      }
      if (hasS && !ds.stencilReadOnly)
      {
        f.stencilLoadOp = ds.stencilLoadOp;
        f.stencilClearValue = ds.stencilClearValue;
        f.stencilStoreOp = 'store';
        c.stencilLoadOp = 'load';
        c.stencilStoreOp = 'store';
        e.stencilLoadOp = 'load';
        e.stencilStoreOp = ds.stencilStoreOp;
        if (ds.stencilStoreOp !== 'store') needsFinal = true;
      }
      first.depthStencilAttachment = f;
      cont.depthStencilAttachment = c;
      fin.depthStencilAttachment = e;
    }

    const tw = desc.timestampWrites;
    if (tw)
    {
      first.timestampWrites = tw.beginningOfPassWriteIndex !== undefined
        ? { querySet: tw.querySet, beginningOfPassWriteIndex: tw.beginningOfPassWriteIndex }
        : undefined;
      if (tw.endOfPassWriteIndex !== undefined)
      {
        fin.timestampWrites = { querySet: tw.querySet, endOfPassWriteIndex: tw.endOfPassWriteIndex };
        needsFinal = true;
      }
    }

    this.rememberAttachments(desc);
    this.contDesc = cont;
    this.finalDesc = fin;
    this.needsFinal = needsFinal;
    this.split = true;
    this.json.split = true;
    return first;
  }

  private closeSegment(): void
  {
    for (let k = 0; k < this.debug.length; k++) G.rp.popDebugGroup.call(this.current);
    G.rp.end.call(this.current);
  }

  private openSegment(): void
  {
    const p = G.enc.beginRenderPass.call(this.enc.encoder, this.contDesc);
    this.current = p;
    if (this.pipeline) G.rp.setPipeline.call(p, this.pipeline);
    for (const [i, b] of this.bindGroups) G.rp.setBindGroup.call(p, i, b.bg, b.offsets);
    for (const [slot, v] of this.vbs)
    {
      if (v.size === undefined) G.rp.setVertexBuffer.call(p, slot, v.buffer, v.offset);
      else G.rp.setVertexBuffer.call(p, slot, v.buffer, v.offset, v.size);
    }
    if (this.ib)
    {
      if (this.ib.size === undefined) G.rp.setIndexBuffer.call(p, this.ib.buffer, this.ib.format, this.ib.offset);
      else G.rp.setIndexBuffer.call(p, this.ib.buffer, this.ib.format, this.ib.offset, this.ib.size);
    }
    if (this.viewport) G.rp.setViewport.apply(p, this.viewport);
    if (this.scissor) G.rp.setScissorRect.apply(p, this.scissor);
    if (this.blend) G.rp.setBlendConstant.call(p, this.blend);
    if (this.stencil !== null) G.rp.setStencilReference.call(p, this.stencil);
    for (const g of this.debug) G.rp.pushDebugGroup.call(p, g);
  }

  private canSnap(): boolean
  {
    if (!this.split) return false;
    const rec = this.rec;
    if (rec.stats.drawSnapshots >= rec.settings.maxDrawSnapshots || rec.snapBytes > SNAPSHOT_MEMORY_LIMIT)
    {
      if (!this.budgetNoted)
      {
        this.budgetNoted = true;
        this.note('Snapshot budget reached: later draws have no image');
        rec.warn(`Per-draw snapshots stopped after ${rec.stats.drawSnapshots} draws (budget). Raise "max draws with images" in the popup to get more.`);
      }
      return false;
    }
    return true;
  }

  private trySnap(c: Cmd): void
  {
    if (!this.canSnap()) return;
    if (this.occlusion)
    {
      this.pendingSnap = c;
      this.note('Occlusion query active: images are taken when the query ends');
      return;
    }
    this.closeSegment();
    c.draw.snap = this.rec.snapshotAttachments(this);
    this.rec.stats.drawSnapshots++;
    this.lastSnappedDraw = this.drawCount;
    this.openSegment();
  }

  private executeBundles(fn: (...a: any[]) => any, args: any[], c: Cmd): any
  {
    const bundles: any[] = Array.from(args[0] ?? []);
    c.a = [bundles];
    c.draw = { state: this.state(), bundleSnaps: [] as (DrawSnaps | null)[] };
    for (const b of bundles)
    {
      const info = getInfo(b);
      if (info?.bundleUsage) this.usage.merge(info.bundleUsage);
      this.rec.stats.draws += info?.draws ?? 0;
      this.drawCount += info?.draws ?? 0;
    }
    const st = this.rec.stack();
    if (st !== undefined) c.st = st;

    if (!this.split || this.occlusion)
    {
      const r = fn.call(this.current, bundles);
      this.resetBindings();
      return r;
    }
    for (const b of bundles)
    {
      G.rp.executeBundles.call(this.current, [b]);
      this.resetBindings();
      if (this.canSnap())
      {
        this.closeSegment();
        const snap = this.rec.snapshotAttachments(this);
        this.rec.stats.drawSnapshots++;
        this.openSegment();
        c.draw.bundleSnaps.push(snap);
        c.draw.snap = snap;
        this.lastSnappedDraw = this.drawCount;
      }
      else c.draw.bundleSnaps.push(null);
    }
    return undefined;
  }

  private resetBindings(): void
  {
    this.pipeline = null;
    this.bindGroups.clear();
    this.vbs.clear();
    this.ib = null;
  }

  private end(fn: (...a: any[]) => any, _c: Cmd): any
  {
    const rec = this.rec;
    let ret: any;
    if (this.kind === 'render' && this.split)
    {
      G.rp.end.call(this.current);
      if (this.needsFinal)
      {
        const p = G.enc.beginRenderPass.call(this.enc.encoder, this.finalDesc);
        G.rp.end.call(p);
      }
    }
    else
    {
      ret = fn.call(this.current);
    }
    rec.closePass(this);

    if (this.kind === 'render')
    {
      if (this.lastSnappedDraw !== this.drawCount || this.drawCount === 0)
      {
        this.json.endSnap = rec.snapshotAttachments(this);
      }
      for (const a of this.colors)
      {
        if (!a) continue;
        const v = viewInfo(a.view);
        if (v) rec.bumpTexture(v.texture);
        const r = viewInfo(a.resolveTarget);
        if (r) rec.bumpTexture(r.texture);
      }
      if (this.ds && !this.ds.depthReadOnly)
      {
        const v = viewInfo(this.ds.view);
        if (v) rec.bumpTexture(v.texture);
      }
    }
    rec.bumpStorageWrites(this.usage);
    rec.snapshotPassResources(this);
    return ret;
  }

  /** Attachments of a pass that was not split still need to be known for the end image. */
  rememberAttachments(desc: any): void
  {
    this.colors = Array.from(desc.colorAttachments ?? [], (a: any) => (a ? { view: a.view, resolveTarget: a.resolveTarget } : null));
    const ds = desc.depthStencilAttachment;
    this.ds = ds ? { view: ds.view, depthReadOnly: ds.depthReadOnly, depthLoadOp: ds.depthLoadOp, depthClearValue: ds.depthClearValue } : null;
  }
}

// ---------------------------------------------------------------------------

type State = 'idle' | 'pending' | 'active' | 'finalizing';

export class Recorder
{
  settings: CaptureSettings = { ...DEFAULT_SETTINGS };
  state: State = 'idle';
  trigger = '';
  hookUrl = '';

  onProgress: (p: CaptureProgress) => void = () => {};
  onResult: (r: CaptureResultMessage) => void = () => {};
  onState: () => void = () => {};

  // capture data
  seq = 0;
  startTime = 0;
  ticks = 0;
  events: Cmd[] = [];
  encoders: EncoderRec[] = [];
  encRecs = new WeakMap<GPUCommandEncoder, EncoderRec>();
  cbRecs = new WeakMap<GPUCommandBuffer, EncoderRec>();
  passRecs = new WeakMap<object, PassRec>();
  openPasses = 0;
  devices = new Set<GPUDevice>();
  stacks: string[] = [];
  stackIdx = new Map<string, number>();
  warnings: string[] = [];
  stats = { submits: 0, commandBuffers: 0, renderPasses: 0, computePasses: 0, draws: 0, dispatches: 0, drawSnapshots: 0 };
  texEpoch = new Map<GPUTexture, number>();
  bufEpoch = new Map<GPUBuffer, number>();
  texSnapCache = new Map<string, { epoch: number; id: number }>();
  bufSnapCache = new Map<GPUBuffer, { epoch: number; id: number }>();
  snaps: PendingSnapshot[] = [];
  bufSnaps: PendingBufferSnapshot[] = [];
  snapBytes = 0;
  bufferBudget = { left: 0 };
  contextsSeen = new Set<GPUCanvasContext>();
  canvasTexturesLogged = new Set<GPUTexture>();

  private pendingTimer: any = 0;
  private idleTimer: any = 0;
  private maxTimer: any = 0;

  get active(): boolean
  {
    return this.state === 'active';
  }

  // -- state machine ----------------------------------------------------------

  request(settings: Partial<CaptureSettings> | undefined): boolean
  {
    if (this.state !== 'idle') return false;
    this.settings = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
    this.state = 'pending';
    this.onState();
    this.onProgress({ phase: 'waiting', message: 'Waiting for the next frame…' });
    // Pages that never call requestAnimationFrame and never present a canvas still get captured.
    this.pendingTimer = setTimeout(() =>
    {
      if (this.state === 'pending') this.start('timer (no requestAnimationFrame or canvas present seen)');
    }, 750);
    return true;
  }

  onFrameTick(): void
  {
    if (this.state === 'active')
    {
      this.ticks++;
      if (this.stats.submits > 0) this.stop();
    }
    else if (this.state === 'pending')
    {
      this.start('requestAnimationFrame');
    }
  }

  /** getCurrentTexture() returned a texture we have not seen for this context: a new frame. */
  onNewCanvasTexture(ctx: GPUCanvasContext): void
  {
    if (this.state === 'active' && this.contextsSeen.has(ctx) && this.stats.submits > 0)
    {
      this.stop();
    }
    else if (this.state === 'pending')
    {
      this.start('canvas getCurrentTexture');
    }
    if (this.state === 'active') this.contextsSeen.add(ctx);
  }

  onSubmit(): void
  {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() =>
    {
      if (this.state === 'active') this.stop();
    }, this.trigger.startsWith('timer') ? 150 : 1000);
  }

  private start(trigger: string): void
  {
    clearTimeout(this.pendingTimer);
    this.resetData();
    this.trigger = trigger;
    this.state = 'active';
    this.startTime = performance.now();
    this.bufferBudget = { left: this.settings.maxTotalBufferBytes };
    this.maxTimer = setTimeout(() =>
    {
      if (this.state === 'active')
      {
        if (this.stats.submits === 0) this.warn('No queue.submit() happened within 10 s of starting the capture.');
        this.stop();
      }
    }, MAX_CAPTURE_MS);
    this.onState();
    this.onProgress({ phase: 'recording', message: 'Recording frame…' });
  }

  stop(): void
  {
    if (this.state !== 'active') return;
    clearTimeout(this.idleTimer);
    clearTimeout(this.maxTimer);
    this.state = 'finalizing';
    this.onState();
    const duration = performance.now() - this.startTime;
    this.finalize(duration).catch((e) =>
    {
      console.error('[WebGPU Spector] capture failed', e);
      this.onProgress({ phase: 'error', message: `Capture failed: ${e?.message ?? e}` });
    }).finally(() =>
    {
      this.resetData();
      this.state = 'idle';
      this.onState();
    });
  }

  private resetData(): void
  {
    this.seq = 0;
    this.ticks = 0;
    this.events = [];
    this.encoders = [];
    this.encRecs = new WeakMap();
    this.cbRecs = new WeakMap();
    this.devices = new Set();
    this.stacks = [];
    this.stackIdx = new Map();
    this.warnings = [];
    this.stats = { submits: 0, commandBuffers: 0, renderPasses: 0, computePasses: 0, draws: 0, dispatches: 0, drawSnapshots: 0 };
    this.texEpoch = new Map();
    this.bufEpoch = new Map();
    this.texSnapCache = new Map();
    this.bufSnapCache = new Map();
    this.snaps = [];
    this.bufSnaps = [];
    this.snapBytes = 0;
    this.contextsSeen = new Set();
    this.canvasTexturesLogged = new Set();
  }

  // -- recording helpers ----------------------------------------------------------

  cmd(n: string, self: any, args: any[] | null): Cmd
  {
    const c: Cmd = { i: this.seq++, n };
    if (self) c.o = self;
    if (args && args.length) c.a = clone(Array.from(args));
    return c;
  }

  event(n: string, self: any, args: any[] | null, ret?: any): Cmd
  {
    const c = this.cmd(n, self, args);
    if (ret && typeof ret === 'object') c.r = ret;
    this.events.push(c);
    return c;
  }

  stack(): number | undefined
  {
    if (!this.settings.stackTraces) return undefined;
    const limit = (Error as any).stackTraceLimit;
    (Error as any).stackTraceLimit = 48;
    const raw = new Error().stack ?? '';
    (Error as any).stackTraceLimit = limit;
    const lines = raw.split('\n').slice(1).filter((l) => !(this.hookUrl && l.includes(this.hookUrl)));
    const s = lines.map((l) => l.trim()).join('\n');
    let idx = this.stackIdx.get(s);
    if (idx === undefined)
    {
      idx = this.stacks.length;
      this.stacks.push(s);
      this.stackIdx.set(s, idx);
    }
    return idx;
  }

  warn(msg: string): void
  {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  bumpTexture(t: GPUTexture | null | undefined): void
  {
    if (t) this.texEpoch.set(t, (this.texEpoch.get(t) ?? 0) + 1);
  }

  bumpBuffer(b: GPUBuffer | null | undefined): void
  {
    if (b) this.bufEpoch.set(b, (this.bufEpoch.get(b) ?? 0) + 1);
  }

  /** Storage bindings may have been written by the pass: invalidate cached snapshots of them. */
  bumpStorageWrites(usage: Usage): void
  {
    for (const bg of usage.bindGroups.keys())
    {
      const entries = getInfo(bg)?.desc?.entries ?? [];
      for (const e of entries)
      {
        const r = e?.resource;
        if (!r) continue;
        const buf = tagOf(r) === 'GPUBuffer' ? r : r.buffer;
        if (buf && tagOf(buf) === 'GPUBuffer' && buf.usage & BU.STORAGE) this.bumpBuffer(buf);
        const vi = viewInfo(r);
        if (vi && vi.texture.usage & TU.STORAGE_BINDING) this.bumpTexture(vi.texture);
      }
    }
  }

  // -- encoders & passes ----------------------------------------------------------

  trackEncoder(encoder: GPUCommandEncoder, device: GPUDevice, desc: any): void
  {
    const er = new EncoderRec(encoder, device, desc?.label);
    this.encRecs.set(encoder, er);
    this.encoders.push(er);
    this.devices.add(device);
  }

  openPass(pr: PassRec, pass: any): void
  {
    this.passRecs.set(pass, pr);
    this.openPasses++;
    if (pr.kind === 'render') this.stats.renderPasses++;
    else this.stats.computePasses++;
  }

  closePass(pr: PassRec): void
  {
    this.passRecs.delete(pr.app);
    this.openPasses = Math.max(0, this.openPasses - 1);
  }

  private snap(pr: PassRec, view: any, depthClear?: number): number | null
  {
    if (!view) return null;
    if (this.snapBytes > SNAPSHOT_MEMORY_LIMIT) return null;
    const device = pr.enc.device;
    G.dev.pushErrorScope.call(device, 'validation');
    let res: ReturnType<typeof snapshotView>;
    try
    {
      res = snapshotView(view, {
        device,
        encoder: pr.enc.encoder,
        owner: pr.enc,
        maxSize: this.settings.snapshotSize,
        floatAsSrgb: this.settings.floatAsSrgb,
        depthClear
      });
    }
    catch (e: any)
    {
      res = { reason: `snapshot failed: ${e?.message ?? e}` };
    }
    G.dev.popErrorScope.call(device).then((err: GPUError | null) =>
    {
      if (err) this.warn(`Snapshot validation error: ${err.message}`);
    }, () => {});
    if (res.snap)
    {
      this.snaps.push(res.snap);
      this.snapBytes += res.snap.bytesPerRow * res.snap.height;
      return res.snap.id;
    }
    if (res.reason) pr.note(res.reason);
    return null;
  }

  snapshotAttachments(pr: PassRec): DrawSnaps
  {
    const c = pr.colors.map((a: any) => (a ? this.snap(pr, a.resolveTarget ?? a.view) : null));
    const out: DrawSnaps = { c };
    if (pr.ds && this.settings.depthSnapshots)
    {
      const clear = pr.ds.depthLoadOp === 'clear' ? pr.ds.depthClearValue : undefined;
      const vi = viewInfo(pr.ds.view);
      if (vi && hasDepthAspect(vi.texture.format)) out.d = this.snap(pr, pr.ds.view, clear);
    }
    return out;
  }

  snapshotPassResources(pr: PassRec): void
  {
    const s = this.settings;
    const attachments = new Set<GPUTexture>();
    for (const a of pr.colors)
    {
      if (!a) continue;
      const v = viewInfo(a.view);
      if (v) attachments.add(v.texture);
      const r = viewInfo(a.resolveTarget);
      if (r) attachments.add(r.texture);
    }
    if (pr.ds)
    {
      const v = viewInfo(pr.ds.view);
      if (v) attachments.add(v.texture);
    }

    const bufferRanges = new Map<GPUBuffer, { offset: number; size: number }[]>();
    for (const [buf, list] of pr.usage.buffers) bufferRanges.set(buf, [...list]);

    for (const [bg, offsetLists] of pr.usage.bindGroups)
    {
      const info = getInfo(bg);
      const entries: any[] = info?.desc?.entries ?? [];
      const dynamicIndex = dynamicBindings(info?.desc?.layout);
      for (const e of entries)
      {
        const r = e?.resource;
        if (!r || typeof r !== 'object') continue;
        const tag = tagOf(r);
        if (tag === 'GPUTextureView' || tag === 'GPUTexture')
        {
          if (!s.textureSnapshots) continue;
          const key = String(idOf(r));
          if (pr.json.texSnaps[key] !== undefined) continue;
          const vi = viewInfo(r);
          if (!vi || attachments.has(vi.texture)) continue;
          const id = this.snapSampled(pr, r, vi);
          if (id !== null) pr.json.texSnaps[key] = id;
          continue;
        }
        const buf: GPUBuffer | null = tag === 'GPUBuffer' ? r : r.buffer && tagOf(r.buffer) === 'GPUBuffer' ? r.buffer : null;
        if (!buf) continue;
        const baseOffset = tag === 'GPUBuffer' ? 0 : r.offset ?? 0;
        const size = tag === 'GPUBuffer' ? buf.size : r.size ?? buf.size - baseOffset;
        const di = dynamicIndex.get(e.binding);
        let list = bufferRanges.get(buf);
        if (!list)
        {
          list = [];
          bufferRanges.set(buf, list);
        }
        for (const offsets of offsetLists)
        {
          const dyn = di !== undefined ? offsets[di] ?? 0 : 0;
          list.push({ offset: baseOffset + dyn, size });
        }
      }
    }

    if (!s.bufferSnapshots) return;
    for (const [buf, ranges] of bufferRanges)
    {
      const info = getInfo(buf);
      if (info?.destroyed) continue;
      const epoch = this.bufEpoch.get(buf) ?? 0;
      const whole = buf.size <= s.maxBufferBytes;
      const cached = whole ? this.bufSnapCache.get(buf) : undefined;
      if (cached && cached.epoch === epoch)
      {
        pr.json.bufSnaps[idOf(buf)] = cached.id;
        continue;
      }
      if (this.bufferBudget.left <= 0)
      {
        this.warn('Buffer snapshot budget reached: some buffers have no contents. Raise it in the popup options.');
        break;
      }
      const snap = snapshotBuffer(buf, ranges, {
        device: pr.enc.device,
        encoder: pr.enc.encoder,
        owner: pr.enc,
        maxBytes: s.maxBufferBytes,
        budget: this.bufferBudget
      });
      if (!snap) continue;
      this.bufSnaps.push(snap);
      pr.json.bufSnaps[idOf(buf)] = snap.id;
      if (whole) this.bufSnapCache.set(buf, { epoch, id: snap.id });
    }
  }

  private snapSampled(pr: PassRec, view: any, vi: ReturnType<typeof viewInfo> & {}): number | null
  {
    const key = `${idOf(vi.texture)}:${vi.baseMipLevel}:${vi.baseArrayLayer}:${vi.format}`;
    const epoch = this.texEpoch.get(vi.texture) ?? 0;
    const cached = this.texSnapCache.get(key);
    if (cached && cached.epoch === epoch) return cached.id;
    const id = this.snap(pr, view);
    if (id !== null) this.texSnapCache.set(key, { epoch, id });
    return id;
  }

  // -- finalize -------------------------------------------------------------------

  private async finalize(durationMs: number): Promise<void>
  {
    const progress = (phase: CaptureProgress['phase'], message: string, done?: number, total?: number) =>
      this.onProgress({ phase, message, done, total });

    if (this.openPasses > 0) this.warn('A pass was still open when the capture ended.');
    for (const er of this.encoders)
    {
      if (!er.submitted && er.cmds.length) this.warn(`Command encoder #${er.id}${er.label ? ` "${er.label}"` : ''} was recorded but not submitted during the capture.`);
    }

    progress('reading', 'Waiting for the GPU…');
    await Promise.all([...this.devices].map((d) => G.queue.onSubmittedWorkDone.call(d.queue).catch(() => {})));

    const images: Record<string, string> = {};
    const snapshots: Record<string, SnapshotJSON> = {};
    const total = this.snaps.length;
    const BATCH = 12;
    for (let i = 0; i < total; i += BATCH)
    {
      progress('reading', `Reading images ${Math.min(i + BATCH, total)} / ${total}`, i, total);
      const group = this.snaps.slice(i, i + BATCH);
      await Promise.all(group.map(async (s) =>
      {
        const meta: SnapshotJSON = {
          kind: s.kind,
          width: s.width,
          height: s.height,
          srcWidth: s.srcWidth,
          srcHeight: s.srcHeight,
          format: s.format,
          texture: s.texture,
          mip: s.mip,
          layer: s.layer,
          sampleCount: s.sampleCount
        };
        try
        {
          if (!s.encoder.submitted)
          {
            meta.missing = 'The command buffer holding this snapshot was never submitted.';
          }
          else
          {
            await G.buf.mapAsync.call(s.buffer, GPUMapMode.READ);
            const data = new Uint8Array((G.buf.getMappedRange.call(s.buffer) as ArrayBuffer).slice(0));
            G.buf.unmap.call(s.buffer);
            images[s.id] = await encodeImage(s, data, meta, this.settings.losslessImages);
          }
        }
        catch (e: any)
        {
          meta.missing = `Readback failed: ${e?.message ?? e}`;
        }
        finally
        {
          try { G.buf.destroy.call(s.buffer); } catch { /* ignore */ }
        }
        snapshots[s.id] = meta;
      }));
    }

    const buffers: Record<string, string> = {};
    const bufferSnapshots: Record<string, BufferSnapshotJSON> = {};
    let bi = 0;
    for (const b of this.bufSnaps)
    {
      if (++bi % 16 === 0) progress('reading', `Reading buffers ${bi} / ${this.bufSnaps.length}`);
      const meta: BufferSnapshotJSON = { buffer: b.buffer, ranges: [] };
      for (const r of b.ranges)
      {
        try
        {
          if (b.encoder.submitted)
          {
            await G.buf.mapAsync.call(r.staging, GPUMapMode.READ);
            const data = new Uint8Array(G.buf.getMappedRange.call(r.staging) as ArrayBuffer);
            buffers[r.key] = toBase64(data);
            G.buf.unmap.call(r.staging);
            meta.ranges.push({ offset: r.offset, size: r.size, key: r.key });
          }
          else meta.missing = 'The command buffer holding this copy was never submitted.';
        }
        catch (e: any)
        {
          meta.missing = `Readback failed: ${e?.message ?? e}`;
        }
        finally
        {
          try { G.buf.destroy.call(r.staging); } catch { /* ignore */ }
        }
      }
      bufferSnapshots[b.id] = meta;
    }

    progress('encoding', 'Serializing commands…');
    const refs = new Set<object>();
    const events = this.events.map((c) => ser(c, refs));
    const encoders: Record<string, any> = {};
    for (const er of this.encoders)
    {
      if (!er.cmds.length && !er.submitted) continue;
      encoders[er.id] = { id: er.id, label: er.label, device: ser(er.device, refs), cmds: ser(er.cmds, refs), submitted: er.submitted };
    }
    const objects = await describeObjects(refs);

    const capture: CaptureJSON = {
      version: 1,
      meta: {
        url: location.href,
        title: document.title,
        time: Date.now(),
        userAgent: navigator.userAgent,
        durationMs,
        settings: this.settings,
        stats: { ...this.stats, encoders: Object.keys(encoders).length, snapshots: Object.keys(images).length, bufferBytes: this.settings.maxTotalBufferBytes - this.bufferBudget.left },
        warnings: this.warnings,
        stacks: this.stacks,
        trigger: this.trigger
      },
      events,
      encoders,
      objects,
      snapshots,
      bufferSnapshots
    };
    progress('saving', 'Sending capture to the extension…');
    this.onResult({ capture, images, buffers });
  }
}

/** binding number → index into the dynamic offsets array, for explicit layouts. */
function dynamicBindings(layout: any): Map<number, number>
{
  const out = new Map<number, number>();
  if (!layout || typeof layout !== 'object') return out;
  const entries: any[] = getInfo(layout)?.desc?.entries ?? [];
  const dyn = entries.filter((e) => e?.buffer?.hasDynamicOffset).sort((a, b) => a.binding - b.binding);
  dyn.forEach((e, i) => out.set(e.binding, i));
  return out;
}

async function encodeImage(s: PendingSnapshot, data: Uint8Array, meta: SnapshotJSON, lossless: boolean): Promise<string>
{
  const { width: w, height: h, bytesPerRow: bpr } = s;
  const img = new ImageData(w, h);
  if (s.kind === 'color')
  {
    for (let y = 0; y < h; y++) img.data.set(data.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
  }
  else
  {
    const f = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    const stride = bpr / 4;
    const clear = s.depthClear;
    let min = Infinity;
    let max = -Infinity;
    for (let y = 0; y < h; y++)
    {
      for (let x = 0; x < w; x++)
      {
        const v = f[y * stride + x];
        if (v === clear || !Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!(min <= max))
    {
      min = 0;
      max = 1;
    }
    const range = max - min || 1;
    meta.depthMin = min;
    meta.depthMax = max;
    for (let y = 0; y < h; y++)
    {
      for (let x = 0; x < w; x++)
      {
        const v = f[y * stride + x];
        let g: number;
        if (v === clear) g = v >= 0.5 ? 255 : 0;
        else g = Math.round(Math.min(1, Math.max(0, (v - min) / range)) * 255);
        const o = (y * w + x) * 4;
        img.data[o] = g;
        img.data[o + 1] = g;
        img.data[o + 2] = g;
        img.data[o + 3] = 255;
      }
    }
  }
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  // WebP: quality 1 is lossless in Chrome, and both modes encode far faster than PNG.
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: lossless || s.kind === 'depth' ? 1 : 0.92 });
  return await new Promise<string>((resolve, reject) =>
  {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------------------
// Object table

async function describeObjects(refs: Set<object>): Promise<Record<string, any>>
{
  const out: Record<string, any> = {};
  const queue = [...refs];
  const seen = new Set<number>();
  const modules: [any, GPUShaderModule][] = [];
  while (queue.length)
  {
    const o = queue.pop()!;
    const id = idOf(o);
    if (seen.has(id)) continue;
    seen.add(id);
    const more = new Set<object>();
    const d = describe(o, more);
    out[id] = d;
    if (d.type === 'GPUShaderModule') modules.push([d, o as GPUShaderModule]);
    for (const r of more) if (!seen.has(idOf(r))) queue.push(r);
  }
  // Compilation messages (warnings/errors) are cheap to fetch and useful next to the source.
  await Promise.all(modules.map(async ([d, m]) =>
  {
    try
    {
      const info: GPUCompilationInfo = await Promise.race([
        G.shader.getCompilationInfo.call(m),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))
      ]);
      d.messages = Array.from(info.messages, (msg) => ({
        type: msg.type, message: msg.message, lineNum: msg.lineNum, linePos: msg.linePos, offset: msg.offset, length: msg.length
      }));
    }
    catch
    {
      // ignore
    }
  }));
  return out;
}

function describe(o: any, refs: Set<object>): any
{
  const tag = tagOf(o);
  const info = getInfo(o) ?? {};
  const out: any = { type: tag, id: idOf(o) };
  const label = o.label;
  if (typeof label === 'string' && label) out.label = label;
  const s = (v: any) => ser(v, refs);
  switch (tag)
  {
    case 'GPUBuffer':
      out.size = o.size;
      out.usage = info.usage ?? o.usage;
      out.mapState = o.mapState;
      if (info.destroyed) out.destroyed = true;
      break;
    case 'GPUTexture':
      out.width = o.width;
      out.height = o.height;
      out.depthOrArrayLayers = o.depthOrArrayLayers;
      out.mipLevelCount = o.mipLevelCount;
      out.sampleCount = o.sampleCount;
      out.dimension = o.dimension;
      out.format = o.format;
      out.usage = info.usage ?? o.usage;
      if (info.desc?.viewFormats?.length) out.viewFormats = s(info.desc.viewFormats);
      if (info.canvasContext) out.canvasContext = s(info.canvasContext);
      if (info.destroyed) out.destroyed = true;
      break;
    case 'GPUTextureView':
    {
      out.texture = info.texture ? s(info.texture) : null;
      out.desc = s(info.desc ?? {});
      const vi = viewInfo(o);
      if (vi)
      {
        const { texture: _t, ...rest } = vi;
        out.resolved = rest;
      }
      break;
    }
    case 'GPUAdapter':
      out.info = o.info ? s(o.info) : undefined;
      out.features = Array.from(o.features ?? []).sort();
      out.limits = s(o.limits);
      out.options = s(info.desc);
      break;
    case 'GPUDevice':
      out.features = Array.from(o.features ?? []).sort();
      out.limits = s(o.limits);
      if (o.adapterInfo) out.adapterInfo = s(o.adapterInfo);
      out.adapter = info.adapter ? s(info.adapter) : null;
      out.desc = s(info.desc);
      break;
    case 'GPUCanvasContext':
    {
      const c = o.canvas;
      out.canvas = c ? { width: c.width, height: c.height, id: c.id || undefined, className: typeof c.className === 'string' ? c.className : undefined, tag: tagOf(c) } : null;
      out.config = s(info.config);
      break;
    }
    case 'GPUShaderModule':
    {
      const { code, ...rest } = info.desc ?? {};
      out.code = typeof code === 'string' ? code : '';
      out.desc = s(rest);
      break;
    }
    case 'GPURenderBundle':
      out.desc = s(info.desc);
      out.encoderDesc = s(info.encoderDesc);
      out.cmds = s(info.cmds ?? []);
      out.draws = info.draws ?? 0;
      break;
    case 'GPUBindGroupLayout':
      if (info.auto)
      {
        out.auto = s(info.auto);
        out.group = info.group;
      }
      else out.desc = s(info.desc);
      break;
    case 'GPUQueue':
      out.device = info.device ? s(info.device) : null;
      break;
    default:
      if (info.desc !== undefined) out.desc = s(info.desc);
      if (info.async) out.async = true;
  }
  return out;
}

export { bytesOf, infoOf };
