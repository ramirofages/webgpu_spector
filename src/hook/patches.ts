// Prototype patches. Creation calls are always tracked (cheap: a WeakMap entry with the cloned
// descriptor) because a capture needs to describe objects created long before it. Command
// recording only happens while a capture is active. Textures and buffers get COPY_SRC /
// TEXTURE_BINDING added so the capture can read them back.

import type { CanvasStatus, PageStatus } from '../shared/protocol';
import { BundleRec, PassRec, internalError, type Recorder } from './capture';
import { BU, TU } from './gpu';
import { getInfo, infoOf, setInfo } from './registry';
import { bytesOf, clone, toBase64 } from './serialize';

type Wrapper = (orig: (...a: any[]) => any) => (this: any, ...args: any[]) => any;

function patch(proto: any, name: string, make: Wrapper): void
{
  if (!proto) return;
  const d = Object.getOwnPropertyDescriptor(proto, name);
  if (!d || typeof d.value !== 'function') return;
  const orig = d.value;
  const wrapped = make(orig);
  Object.defineProperty(wrapped, 'name', { value: name, configurable: true });
  Object.defineProperty(wrapped, 'length', { value: orig.length, configurable: true });
  Object.defineProperty(proto, name, { ...d, value: wrapped });
}

function methods(proto: any): string[]
{
  if (!proto) return [];
  return Object.getOwnPropertyNames(proto).filter((n) =>
  {
    if (n === 'constructor') return false;
    const d = Object.getOwnPropertyDescriptor(proto, n);
    return !!d && typeof d.value === 'function';
  });
}

function guard(fn: () => void): void
{
  try
  {
    fn();
  }
  catch (e)
  {
    internalError(e);
  }
}

export class StatusTracker
{
  adapters = 0;
  devices = 0;
  submits = 0;
  lastSubmit: number | null = null;
  contexts: WeakRef<GPUCanvasContext>[] = [];
  private timer: any = 0;

  constructor(private rec: Recorder, private post: (s: PageStatus) => void) {}

  addContext(ctx: GPUCanvasContext): void
  {
    if (!this.contexts.some((r) => r.deref() === ctx)) this.contexts.push(new WeakRef(ctx));
    this.changed();
  }

  changed(): void
  {
    if (this.timer) return;
    this.timer = setTimeout(() =>
    {
      this.timer = 0;
      this.post(this.snapshot());
    }, 250);
  }

  snapshot(): PageStatus
  {
    const canvases: CanvasStatus[] = [];
    this.contexts = this.contexts.filter((r) => r.deref());
    for (const r of this.contexts)
    {
      const ctx = r.deref()!;
      const c: any = ctx.canvas;
      const cfg = getInfo(ctx)?.config;
      if (!cfg) continue;
      canvases.push({
        width: c?.width ?? 0,
        height: c?.height ?? 0,
        format: String(cfg.format ?? ''),
        id: c?.id ? `#${c.id}` : typeof c?.className === 'string' && c.className ? `.${c.className.split(/\s+/)[0]}` : c instanceof OffscreenCanvas ? 'OffscreenCanvas' : 'canvas'
      });
    }
    return {
      webgpu: true,
      adapters: this.adapters,
      devices: this.devices,
      canvases,
      submits: this.submits,
      lastSubmit: this.lastSubmit,
      capturing: this.rec.state !== 'idle',
      url: location.href,
      title: document.title
    };
  }
}

const bundleRecs = new WeakMap<GPURenderBundleEncoder, BundleRec>();

export function installPatches(rec: Recorder, status: StatusTracker): void
{
  // -- adapter / device -----------------------------------------------------------

  patch(GPU.prototype, 'requestAdapter', (orig) => function (this: GPU, ...args: any[])
  {
    return orig.apply(this, args).then((adapter: GPUAdapter | null) =>
    {
      if (adapter) guard(() =>
      {
        setInfo(adapter, { desc: clone(args[0]) });
        status.adapters++;
        status.changed();
      });
      return adapter;
    });
  });

  patch(GPUAdapter.prototype, 'requestDevice', (orig) => function (this: GPUAdapter, ...args: any[])
  {
    return orig.apply(this, args).then((device: GPUDevice) =>
    {
      guard(() =>
      {
        setInfo(device, { adapter: this, desc: clone(args[0]) });
        setInfo(device.queue, { device });
        status.devices++;
        status.changed();
      });
      return device;
    });
  });

  const D = GPUDevice.prototype;

  patch(D, 'createBuffer', (orig) => function (this: GPUDevice, ...args: any[])
  {
    const desc = args[0];
    const usage = desc?.usage;
    if (typeof usage === 'number' && !(usage & BU.MAP_READ) && !(usage & BU.COPY_SRC))
    {
      args = [{ ...desc, label: desc.label, size: desc.size, mappedAtCreation: desc.mappedAtCreation, usage: usage | BU.COPY_SRC }, ...args.slice(1)];
    }
    const buf = orig.apply(this, args);
    guard(() =>
    {
      setInfo(buf, { desc: clone(desc), usage });
      if (rec.active) rec.event('createBuffer', this, [desc], buf);
    });
    return buf;
  });

  patch(D, 'createTexture', (orig) => function (this: GPUDevice, ...args: any[])
  {
    const desc = args[0];
    const usage = desc?.usage;
    const add = TU.COPY_SRC | TU.TEXTURE_BINDING;
    if (typeof usage === 'number' && !(usage & TU.TRANSIENT_ATTACHMENT) && (usage & add) !== add)
    {
      args = [{
        ...desc,
        label: desc.label,
        size: desc.size,
        mipLevelCount: desc.mipLevelCount,
        sampleCount: desc.sampleCount,
        dimension: desc.dimension,
        format: desc.format,
        viewFormats: desc.viewFormats,
        usage: usage | add
      }, ...args.slice(1)];
    }
    const tex = orig.apply(this, args);
    guard(() =>
    {
      setInfo(tex, { desc: clone(desc), usage });
      if (rec.active)
      {
        rec.event('createTexture', this, [desc], tex);
      }
    });
    return tex;
  });

  const simpleCreations = [
    'createSampler', 'importExternalTexture', 'createBindGroupLayout', 'createPipelineLayout', 'createBindGroup',
    'createShaderModule', 'createComputePipeline', 'createRenderPipeline', 'createQuerySet'
  ];
  for (const name of simpleCreations)
  {
    patch(D, name, (orig) => function (this: GPUDevice, ...args: any[])
    {
      const ret = orig.apply(this, args);
      guard(() =>
      {
        setInfo(ret, { desc: clone(args[0]) });
        if (rec.active) rec.event(name, this, args, ret);
      });
      return ret;
    });
  }

  for (const name of ['createComputePipelineAsync', 'createRenderPipelineAsync'])
  {
    patch(D, name, (orig) => function (this: GPUDevice, ...args: any[])
    {
      let desc: any;
      guard(() =>
      {
        desc = clone(args[0]);
        if (rec.active) rec.event(name, this, args);
      });
      return orig.apply(this, args).then((p: any) =>
      {
        guard(() => setInfo(p, { desc, async: true }));
        return p;
      });
    });
  }

  patch(D, 'createCommandEncoder', (orig) => function (this: GPUDevice, ...args: any[])
  {
    const enc = orig.apply(this, args);
    if (rec.active) guard(() => rec.trackEncoder(enc, this, args[0]));
    return enc;
  });

  patch(D, 'createRenderBundleEncoder', (orig) => function (this: GPUDevice, ...args: any[])
  {
    const enc = orig.apply(this, args);
    guard(() =>
    {
      bundleRecs.set(enc, new BundleRec(clone(args[0])));
      if (rec.active) rec.event('createRenderBundleEncoder', this, args, enc);
    });
    return enc;
  });

  for (const P of [GPURenderPipeline.prototype, GPUComputePipeline.prototype])
  {
    patch(P, 'getBindGroupLayout', (orig) => function (this: any, ...args: any[])
    {
      const bgl = orig.apply(this, args);
      guard(() =>
      {
        if (!getInfo(bgl)) setInfo(bgl, { auto: this, group: args[0] });
      });
      return bgl;
    });
  }

  // -- buffers & textures ------------------------------------------------------------

  patch(GPUBuffer.prototype, 'destroy', (orig) => function (this: GPUBuffer, ...args: any[])
  {
    guard(() =>
    {
      infoOf(this).destroyed = true;
      if (rec.active) rec.event('destroy', this, null);
    });
    return orig.apply(this, args);
  });

  patch(GPUBuffer.prototype, 'mapAsync', (orig) => function (this: GPUBuffer, ...args: any[])
  {
    guard(() =>
    {
      infoOf(this).mapMode = args[0];
      if (rec.active) rec.event('mapAsync', this, args);
    });
    return orig.apply(this, args);
  });

  patch(GPUBuffer.prototype, 'unmap', (orig) => function (this: GPUBuffer, ...args: any[])
  {
    guard(() =>
    {
      const info = infoOf(this);
      const writes = (info.mapMode ?? 0) & GPUMapMode.WRITE || (info.desc?.mappedAtCreation && !info.unmapped);
      info.unmapped = true;
      info.mapMode = 0;
      if (writes) rec.bumpBuffer(this);
      if (rec.active) rec.event('unmap', this, null);
    });
    return orig.apply(this, args);
  });

  patch(GPUTexture.prototype, 'createView', (orig) => function (this: GPUTexture, ...args: any[])
  {
    const view = orig.apply(this, args);
    guard(() => setInfo(view, { texture: this, desc: clone(args[0]) }));
    return view;
  });

  patch(GPUTexture.prototype, 'destroy', (orig) => function (this: GPUTexture, ...args: any[])
  {
    guard(() =>
    {
      infoOf(this).destroyed = true;
      if (rec.active) rec.event('destroy', this, null);
    });
    return orig.apply(this, args);
  });

  // -- canvas ---------------------------------------------------------------------------

  patch(GPUCanvasContext.prototype, 'configure', (orig) => function (this: GPUCanvasContext, ...args: any[])
  {
    const cfg = args[0];
    if (cfg && typeof cfg === 'object')
    {
      const usage = cfg.usage ?? TU.RENDER_ATTACHMENT;
      if (typeof usage === 'number')
      {
        args = [{
          ...cfg,
          device: cfg.device,
          format: cfg.format,
          alphaMode: cfg.alphaMode,
          colorSpace: cfg.colorSpace,
          toneMapping: cfg.toneMapping,
          viewFormats: cfg.viewFormats,
          usage: usage | TU.COPY_SRC | TU.TEXTURE_BINDING
        }, ...args.slice(1)];
      }
    }
    const ret = orig.apply(this, args);
    guard(() =>
    {
      const info = infoOf(this);
      info.config = clone(cfg);
      info.usage = cfg?.usage ?? TU.RENDER_ATTACHMENT;
      status.addContext(this);
      if (rec.active) rec.event('configure', this, [cfg]);
    });
    return ret;
  });

  patch(GPUCanvasContext.prototype, 'getCurrentTexture', (orig) => function (this: GPUCanvasContext, ...args: any[])
  {
    const tex = orig.apply(this, args);
    guard(() =>
    {
      const ci = infoOf(this);
      if (!getInfo(tex)) setInfo(tex, { canvasContext: this, usage: ci.usage ?? TU.RENDER_ATTACHMENT });
      if (ci.lastTex !== tex)
      {
        ci.lastTex = tex;
        rec.onNewCanvasTexture(this);
      }
      if (rec.active && !rec.canvasTexturesLogged.has(tex))
      {
        rec.canvasTexturesLogged.add(tex);
        rec.event('getCurrentTexture', this, null, tex);
      }
    });
    return tex;
  });

  // -- queue ------------------------------------------------------------------------------

  const Q = GPUQueue.prototype;

  patch(Q, 'submit', (orig) => function (this: GPUQueue, ...args: any[])
  {
    status.submits++;
    status.lastSubmit = Date.now();
    if (rec.active) guard(() =>
    {
      const list: GPUCommandBuffer[] = Array.from(args[0] ?? []);
      const ids = list.map((cb) =>
      {
        const er = rec.cbRecs.get(cb);
        if (!er) return null;
        er.submitted = true;
        return er.id;
      });
      rec.stats.submits++;
      rec.stats.commandBuffers += list.length;
      const c = rec.event('submit', this, null);
      c.cbs = ids;
      const st = rec.stack();
      if (st !== undefined) c.st = st;
    });
    const ret = orig.apply(this, args);
    if (rec.active) rec.onSubmit();
    return ret;
  });

  patch(Q, 'writeBuffer', (orig) => function (this: GPUQueue, ...args: any[])
  {
    if (rec.active) guard(() =>
    {
      const [buffer, offset, data, dataOffset, size] = args;
      const c = rec.event('writeBuffer', this, null);
      c.a = [buffer, offset, clone(data), dataOffset, size];
      const bytes = bytesOf(data, dataOffset, size);
      if (bytes) c.x = { bytes: bytes.byteLength, preview: toBase64(bytes.subarray(0, 4096)) };
      rec.bumpBuffer(buffer);
    });
    return orig.apply(this, args);
  });

  for (const name of ['writeTexture', 'copyExternalImageToTexture'])
  {
    patch(Q, name, (orig) => function (this: GPUQueue, ...args: any[])
    {
      if (rec.active) guard(() =>
      {
        rec.event(name, this, args);
        rec.bumpTexture(name === 'writeTexture' ? args[0]?.texture : args[1]?.texture);
      });
      return orig.apply(this, args);
    });
  }

  // -- command encoder ----------------------------------------------------------------

  const E = GPUCommandEncoder.prototype;

  patch(E, 'beginRenderPass', (orig) => function (this: GPUCommandEncoder, ...args: any[])
  {
    const er = rec.active ? rec.encRecs.get(this) : undefined;
    if (!er) return orig.apply(this, args);
    const desc = args[0];
    let pr: PassRec | null = null;
    let first: any = null;
    try
    {
      pr = new PassRec(rec, 'render', er, null);
      if (rec.settings.drawSnapshots) first = pr.prepareSplit(desc);
      if (!first) pr.rememberAttachments(desc);
    }
    catch (e)
    {
      internalError(e);
      pr = null;
      first = null;
    }
    const pass = first ? orig.call(this, first) : orig.apply(this, args);
    if (pr)
    {
      const p = pr;
      guard(() =>
      {
        p.app = pass;
        p.current = pass;
        const c = rec.cmd('beginRenderPass', null, args);
        c.pass = p.json;
        const st = rec.stack();
        if (st !== undefined) c.st = st;
        er.cmds.push(c);
        rec.openPass(p, pass);
      });
    }
    return pass;
  });

  patch(E, 'beginComputePass', (orig) => function (this: GPUCommandEncoder, ...args: any[])
  {
    const pass = orig.apply(this, args);
    const er = rec.active ? rec.encRecs.get(this) : undefined;
    if (er) guard(() =>
    {
      const pr = new PassRec(rec, 'compute', er, pass);
      const c = rec.cmd('beginComputePass', null, args);
      c.pass = pr.json;
      er.cmds.push(c);
      rec.openPass(pr, pass);
    });
    return pass;
  });

  patch(E, 'finish', (orig) => function (this: GPUCommandEncoder, ...args: any[])
  {
    const cb = orig.apply(this, args);
    const er = rec.encRecs.get(this);
    if (er) guard(() =>
    {
      rec.cbRecs.set(cb, er);
      if (rec.active) er.cmds.push(rec.cmd('finish', null, args));
    });
    return cb;
  });

  for (const name of methods(E))
  {
    if (name === 'beginRenderPass' || name === 'beginComputePass' || name === 'finish') continue;
    patch(E, name, (orig) => function (this: GPUCommandEncoder, ...args: any[])
    {
      const er = rec.active ? rec.encRecs.get(this) : undefined;
      if (er) guard(() =>
      {
        er.cmds.push(rec.cmd(name, null, args));
        switch (name)
        {
          case 'copyBufferToBuffer':
            rec.bumpBuffer(args.length <= 3 ? args[1] : args[2]);
            break;
          case 'copyBufferToTexture':
          case 'copyTextureToTexture':
            rec.bumpTexture(args[1]?.texture);
            break;
          case 'copyTextureToBuffer':
            rec.bumpBuffer(args[1]?.buffer);
            break;
          case 'clearBuffer':
            rec.bumpBuffer(args[0]);
            break;
          case 'resolveQuerySet':
            rec.bumpBuffer(args[3]);
            break;
        }
      });
      return orig.apply(this, args);
    });
  }

  // -- passes -------------------------------------------------------------------------

  for (const proto of [GPURenderPassEncoder.prototype, GPUComputePassEncoder.prototype])
  {
    for (const name of methods(proto))
    {
      patch(proto, name, (orig) => function (this: any, ...args: any[])
      {
        if (rec.openPasses === 0) return orig.apply(this, args);
        const pr = rec.passRecs.get(this);
        if (!pr) return orig.apply(this, args);
        return pr.invoke(name, orig, args);
      });
    }
  }

  const RBE = GPURenderBundleEncoder.prototype;
  for (const name of methods(RBE))
  {
    if (name === 'finish') continue;
    patch(RBE, name, (orig) => function (this: GPURenderBundleEncoder, ...args: any[])
    {
      const br = bundleRecs.get(this);
      if (br) guard(() => br.invoke(name, args));
      return orig.apply(this, args);
    });
  }
  patch(RBE, 'finish', (orig) => function (this: GPURenderBundleEncoder, ...args: any[])
  {
    const bundle = orig.apply(this, args);
    const br = bundleRecs.get(this);
    if (br) guard(() =>
    {
      setInfo(bundle, { desc: clone(args[0]), encoderDesc: br.desc, cmds: br.cmds, bundleUsage: br.usage, draws: br.draws });
      bundleRecs.delete(this);
    });
    return bundle;
  });

  // -- frame boundaries -------------------------------------------------------------------

  const raf = window.requestAnimationFrame;
  if (typeof raf === 'function')
  {
    let lastTick = -1;
    window.requestAnimationFrame = function (cb: FrameRequestCallback): number
    {
      if (typeof cb !== 'function') return raf.call(window, cb);
      return raf.call(window, function (this: any, t: number)
      {
        if (t !== lastTick)
        {
          lastTick = t;
          guard(() => rec.onFrameTick());
        }
        return cb.call(this, t);
      });
    };
  }
}
