// GPU side of the visual states: small blit passes that copy (and downscale) an attachment
// or a sampled texture into an rgba8 / r32float image, plus buffer range copies. Everything is
// encoded on the page's own command encoder, between passes, so it runs in queue order with
// the page's work and sees exactly what the GPU saw.

import { channelCount, hasDepthAspect, isFloatFormat, isSrgbFormat, sampleKind, type SampleKind } from '../shared/formats';
import { BU, G, TU } from './gpu';
import { getInfo, idOf, tagOf } from './registry';

export interface ViewInfo
{
  texture: GPUTexture;
  format: string;
  dimension: string;
  aspect: string;
  baseMipLevel: number;
  mipLevelCount: number;
  baseArrayLayer: number;
  arrayLayerCount: number;
}

/** Resolves a GPUTextureView (or a GPUTexture used as its default view) to concrete values. */
export function viewInfo(view: any): ViewInfo | null
{
  if (!view || typeof view !== 'object') return null;
  const tag = tagOf(view);
  let tex: GPUTexture;
  let d: any;
  if (tag === 'GPUTexture')
  {
    tex = view;
    d = {};
  }
  else if (tag === 'GPUTextureView')
  {
    const info = getInfo(view);
    if (!info || !info.texture) return null;
    if (info.resolved) return info.resolved;
    tex = info.texture;
    d = info.desc ?? {};
  }
  else
  {
    return null;
  }

  const aspect = d.aspect ?? 'all';
  let format = d.format ?? tex.format;
  if (!d.format && aspect === 'depth-only')
  {
    if (tex.format === 'depth24plus-stencil8') format = 'depth24plus';
    if (tex.format === 'depth32float-stencil8') format = 'depth32float';
  }
  if (!d.format && aspect === 'stencil-only') format = 'stencil8';

  let dimension = d.dimension;
  if (!dimension)
  {
    if (tex.dimension === '1d') dimension = '1d';
    else if (tex.dimension === '3d') dimension = '3d';
    else dimension = tex.depthOrArrayLayers > 1 ? '2d-array' : '2d';
  }
  const baseMipLevel = d.baseMipLevel ?? 0;
  const baseArrayLayer = d.baseArrayLayer ?? 0;
  const layers = tex.dimension === '3d' ? 1 : tex.depthOrArrayLayers;
  const resolved: ViewInfo = {
    texture: tex,
    format,
    dimension,
    aspect,
    baseMipLevel,
    mipLevelCount: d.mipLevelCount ?? tex.mipLevelCount - baseMipLevel,
    baseArrayLayer,
    arrayLayerCount: d.arrayLayerCount ??
      (dimension === '2d-array' || dimension === 'cube-array' ? layers - baseArrayLayer : dimension === 'cube' ? 6 : 1)
  };
  if (tag === 'GPUTextureView') getInfo(view)!.resolved = resolved;
  return resolved;
}

// ---------------------------------------------------------------------------

interface BlitPipeline
{
  pipeline: GPURenderPipeline;
  bgl: GPUBindGroupLayout;
}

interface DeviceBlit
{
  pipelines: Map<string, BlitPipeline>;
  params: Map<string, GPUBuffer>;
  targets: Map<string, { tex: GPUTexture; view: GPUTextureView }>;
  views: WeakMap<GPUTexture, Map<string, GPUTextureView>>;
}

const perDevice = new WeakMap<GPUDevice, DeviceBlit>();

function blitFor(device: GPUDevice): DeviceBlit
{
  let b = perDevice.get(device);
  if (!b)
  {
    b = { pipelines: new Map(), params: new Map(), targets: new Map(), views: new WeakMap() };
    perDevice.set(device, b);
  }
  return b;
}

function textureType(kind: SampleKind, ms: boolean): string
{
  switch (kind)
  {
    case 'depth': return ms ? 'texture_depth_multisampled_2d' : 'texture_depth_2d';
    case 'uint': return ms ? 'texture_multisampled_2d<u32>' : 'texture_2d<u32>';
    case 'sint': return ms ? 'texture_multisampled_2d<i32>' : 'texture_2d<i32>';
    default: return ms ? 'texture_multisampled_2d<f32>' : 'texture_2d<f32>';
  }
}

function blitShader(kind: SampleKind, ms: boolean): string
{
  let fetch: string;
  if (kind === 'depth') fetch = 'vec4f(textureLoad(t, c, 0), 0.0, 0.0, 1.0)';
  else if (kind === 'uint') fetch = 'hashColor(textureLoad(t, c, 0).r)';
  else if (kind === 'sint') fetch = 'hashColor(bitcast<u32>(textureLoad(t, c, 0).r))';
  else fetch = 'textureLoad(t, c, 0)';

  const finish = kind === 'depth'
    ? 'return vec4f(v.r, 0.0, 0.0, 1.0);'
    : `var rgb = v.rgb;
  if (P.channels == 1u) { rgb = vec3f(v.r); }
  else if (P.channels == 2u) { rgb = vec3f(v.r, v.g, 0.0); }
  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
  if ((P.mode & 1u) != 0u) { rgb = toSrgb(rgb); }
  return vec4f(rgb, 1.0);`;

  return /* wgsl */ `
struct Params { src: vec2u, dst: vec2u, mode: u32, channels: u32, ss: u32, pad: u32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var t: ${textureType(kind, ms)};

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn hashColor(v: u32) -> vec4f {
  if (v == 0u) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  var h = v * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return vec4f(f32(h & 255u) / 255.0, f32((h >> 8u) & 255u) / 255.0, f32((h >> 16u) & 255u) / 255.0, 1.0);
}

fn toSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn fetchTexel(c: vec2i) -> vec4f { return ${fetch}; }

@fragment fn fs(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let scale = vec2f(P.src) / vec2f(P.dst);
  let n = max(P.ss, 1u);
  let base = floor(fp.xy);
  let maxc = vec2i(P.src) - vec2i(1);
  var acc = vec4f(0.0);
  for (var y = 0u; y < n; y++) {
    for (var x = 0u; x < n; x++) {
      let sp = (base + (vec2f(f32(x), f32(y)) + 0.5) / f32(n)) * scale;
      acc += fetchTexel(clamp(vec2i(sp), vec2i(0), maxc));
    }
  }
  let v = acc / f32(n * n);
  ${finish}
}
`;
}

function pipelineFor(device: GPUDevice, kind: SampleKind, ms: boolean, target: GPUTextureFormat): BlitPipeline
{
  const b = blitFor(device);
  const key = `${kind}:${ms}:${target}`;
  let p = b.pipelines.get(key);
  if (p) return p;

  const sampleType: GPUTextureSampleType = kind === 'depth' ? 'depth' : kind === 'uint' ? 'uint' : kind === 'sint' ? 'sint' : 'unfilterable-float';
  G.dev.pushErrorScope.call(device, 'validation');
  const module = G.dev.createShaderModule.call(device, { label: 'webgpu-spector blit', code: blitShader(kind, ms) });
  const bgl = G.dev.createBindGroupLayout.call(device, {
    label: 'webgpu-spector blit',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType, viewDimension: '2d', multisampled: ms } }
    ]
  });
  const layout = G.dev.createPipelineLayout.call(device, { bindGroupLayouts: [bgl] });
  const pipeline = G.dev.createRenderPipeline.call(device, {
    label: 'webgpu-spector blit',
    layout,
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: target }] },
    primitive: { topology: 'triangle-list' }
  });
  G.dev.popErrorScope.call(device).then((err: GPUError | null) =>
  {
    if (err) console.warn('[WebGPU Spector] blit pipeline error:', err.message);
  });
  p = { pipeline, bgl };
  b.pipelines.set(key, p);
  return p;
}

function paramsFor(device: GPUDevice, values: number[]): GPUBuffer
{
  const b = blitFor(device);
  const key = values.join(',');
  let buf = b.params.get(key);
  if (buf) return buf;
  buf = G.dev.createBuffer.call(device, { label: 'webgpu-spector params', size: 32, usage: BU.UNIFORM, mappedAtCreation: true }) as GPUBuffer;
  new Uint32Array(G.buf.getMappedRange.call(buf)).set(values);
  G.buf.unmap.call(buf);
  b.params.set(key, buf);
  return buf;
}

function targetFor(device: GPUDevice, format: GPUTextureFormat, w: number, h: number)
{
  const b = blitFor(device);
  const key = `${format}:${w}x${h}`;
  let t = b.targets.get(key);
  if (t) return t;
  const tex = G.dev.createTexture.call(device, {
    label: 'webgpu-spector snapshot',
    size: [w, h],
    format,
    usage: TU.RENDER_ATTACHMENT | TU.COPY_SRC
  }) as GPUTexture;
  t = { tex, view: G.tex.createView.call(tex) };
  b.targets.set(key, t);
  return t;
}

function samplingView(device: GPUDevice, vi: ViewInfo, kind: SampleKind): GPUTextureView
{
  const b = blitFor(device);
  let m = b.views.get(vi.texture);
  if (!m)
  {
    m = new Map();
    b.views.set(vi.texture, m);
  }
  const key = `${kind}:${vi.format}:${vi.baseMipLevel}:${vi.baseArrayLayer}`;
  let v = m.get(key);
  if (v) return v;
  const desc: GPUTextureViewDescriptor = {
    label: 'webgpu-spector sample',
    dimension: '2d',
    baseMipLevel: vi.baseMipLevel,
    mipLevelCount: 1,
    baseArrayLayer: vi.baseArrayLayer,
    arrayLayerCount: 1
  };
  if (kind === 'depth')
  {
    desc.aspect = 'depth-only';
  }
  else
  {
    desc.format = vi.format as GPUTextureFormat;
  }
  v = G.tex.createView.call(vi.texture, desc) as GPUTextureView;
  m.set(key, v);
  return v;
}

export interface PendingSnapshot
{
  id: number;
  encoder: { submitted: boolean };
  buffer: GPUBuffer;
  bytesPerRow: number;
  kind: 'color' | 'depth';
  width: number;
  height: number;
  srcWidth: number;
  srcHeight: number;
  format: string;
  texture: number;
  mip: number;
  layer: number;
  sampleCount: number;
  depthClear?: number;
}

export interface SnapshotRequest
{
  device: GPUDevice;
  encoder: GPUCommandEncoder;
  owner: { submitted: boolean };
  maxSize: number;
  floatAsSrgb: boolean;
  depthClear?: number;
}

let nextSnapId = 1;

/**
 * Encodes a copy of `view` (one mip / layer) into a mappable buffer. Must be called while
 * `encoder` has no open pass. Returns null (with a reason) when the view cannot be sampled.
 */
export function snapshotView(view: any, req: SnapshotRequest): { snap?: PendingSnapshot; reason?: string }
{
  const vi = viewInfo(view);
  if (!vi) return { reason: 'unknown view' };
  const tex = vi.texture;
  if (!(tex.usage & TU.TEXTURE_BINDING)) return { reason: 'texture cannot be sampled (no TEXTURE_BINDING usage)' };
  if (tex.dimension !== '2d') return { reason: `${tex.dimension} textures are not previewed` };
  const kind = sampleKind(vi.format, vi.aspect);
  if (kind === 'stencil') return { reason: 'stencil is not previewed' };
  if (kind === 'depth' && !hasDepthAspect(tex.format)) return { reason: 'no depth aspect' };

  const ms = tex.sampleCount > 1;
  const srcW = Math.max(1, tex.width >> vi.baseMipLevel);
  const srcH = Math.max(1, tex.height >> vi.baseMipLevel);
  const scale = Math.min(1, req.maxSize / Math.max(srcW, srcH));
  const dstW = Math.max(1, Math.round(srcW * scale));
  const dstH = Math.max(1, Math.round(srcH * scale));
  const target: GPUTextureFormat = kind === 'depth' ? 'r32float' : 'rgba8unorm';
  const device = req.device;

  const intKind = kind === 'uint' || kind === 'sint';
  const ss = intKind ? 1 : Math.min(4, Math.max(1, Math.ceil(Math.max(srcW / dstW, srcH / dstH))));
  const srgb = !intKind && kind !== 'depth' && (isSrgbFormat(vi.format) || (req.floatAsSrgb && isFloatFormat(vi.format)));
  const channels = intKind || kind === 'depth' ? 4 : channelCount(vi.format);

  const pipe = pipelineFor(device, kind, ms, target);
  const params = paramsFor(device, [srcW, srcH, dstW, dstH, srgb ? 1 : 0, channels, ss, 0]);
  const sv = samplingView(device, vi, kind);
  const bg = G.dev.createBindGroup.call(device, {
    layout: pipe.bgl,
    entries: [
      { binding: 0, resource: { buffer: params } },
      { binding: 1, resource: sv }
    ]
  });
  const t = targetFor(device, target, dstW, dstH);
  const pass = G.enc.beginRenderPass.call(req.encoder, {
    label: 'webgpu-spector snapshot',
    colorAttachments: [{ view: t.view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }]
  });
  G.rp.setPipeline.call(pass, pipe.pipeline);
  G.rp.setBindGroup.call(pass, 0, bg);
  G.rp.draw.call(pass, 3);
  G.rp.end.call(pass);

  const bytesPerRow = Math.ceil((dstW * 4) / 256) * 256;
  const buffer = G.dev.createBuffer.call(device, {
    label: 'webgpu-spector readback',
    size: bytesPerRow * dstH,
    usage: BU.MAP_READ | BU.COPY_DST
  }) as GPUBuffer;
  G.enc.copyTextureToBuffer.call(req.encoder, { texture: t.tex }, { buffer, bytesPerRow, rowsPerImage: dstH }, { width: dstW, height: dstH });

  return {
    snap: {
      id: nextSnapId++,
      encoder: req.owner,
      buffer,
      bytesPerRow,
      kind: kind === 'depth' ? 'depth' : 'color',
      width: dstW,
      height: dstH,
      srcWidth: srcW,
      srcHeight: srcH,
      format: vi.format,
      texture: idOf(tex),
      mip: vi.baseMipLevel,
      layer: vi.baseArrayLayer,
      sampleCount: tex.sampleCount,
      depthClear: req.depthClear
    }
  };
}

export interface PendingBufferSnapshot
{
  id: number;
  encoder: { submitted: boolean };
  buffer: number;
  ranges: { offset: number; size: number; staging: GPUBuffer; key: string }[];
}

let nextBufSnapId = 1;

export function mergeRanges(ranges: { offset: number; size: number }[]): { offset: number; size: number }[]
{
  const sorted = ranges.filter((r) => r.size > 0).sort((a, b) => a.offset - b.offset);
  const out: { offset: number; size: number }[] = [];
  for (const r of sorted)
  {
    const last = out[out.length - 1];
    if (last && r.offset <= last.offset + last.size + 256)
    {
      last.size = Math.max(last.size, r.offset + r.size - last.offset);
    }
    else
    {
      out.push({ offset: r.offset, size: r.size });
    }
  }
  return out;
}

export function snapshotBuffer(
  buffer: GPUBuffer,
  ranges: { offset: number; size: number }[],
  req: { device: GPUDevice; encoder: GPUCommandEncoder; owner: { submitted: boolean }; maxBytes: number; budget: { left: number } }
): PendingBufferSnapshot | null
{
  if (!(buffer.usage & BU.COPY_SRC)) return null;
  const size = buffer.size;
  const wanted = size <= req.maxBytes
    ? [{ offset: 0, size }]
    : mergeRanges(ranges).map((r) => ({ offset: r.offset, size: Math.min(r.size, req.maxBytes) }));
  const id = nextBufSnapId++;
  const snap: PendingBufferSnapshot = { id, encoder: req.owner, buffer: idOf(buffer), ranges: [] };
  for (const r of wanted)
  {
    const offset = r.offset & ~3;
    const end = Math.min(size, r.offset + r.size);
    const len = (end - offset) & ~3;
    if (len <= 0) continue;
    if (len > req.budget.left) break;
    req.budget.left -= len;
    const staging = G.dev.createBuffer.call(req.device, {
      label: 'webgpu-spector buffer readback',
      size: len,
      usage: BU.MAP_READ | BU.COPY_DST
    }) as GPUBuffer;
    G.enc.copyBufferToBuffer.call(req.encoder, buffer, offset, staging, 0, len);
    snap.ranges.push({ offset, size: len, staging, key: `${id}_${snap.ranges.length}` });
  }
  return snap.ranges.length ? snap : null;
}
