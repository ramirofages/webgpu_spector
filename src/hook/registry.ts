// Object identity and creation info for every WebGPU object the page makes.
// Everything is keyed by WeakMap so objects the page drops are collected normally.

let nextId = 1;
const ids = new WeakMap<object, number>();
const infos = new WeakMap<object, Info>();

export interface Info
{
  /** Cloned creation descriptor (GPU objects kept as live references). */
  desc?: any;
  /** Usage as requested by the page, before we added COPY_SRC / TEXTURE_BINDING. */
  usage?: number;
  destroyed?: boolean;
  [key: string]: any;
}

export function idOf(obj: object): number
{
  let id = ids.get(obj);
  if (id === undefined)
  {
    id = nextId++;
    ids.set(obj, id);
  }
  return id;
}

export function getInfo(obj: object): Info | undefined
{
  return infos.get(obj);
}

export function setInfo(obj: object, info: Info): Info
{
  infos.set(obj, info);
  return info;
}

export function infoOf(obj: object): Info
{
  let info = infos.get(obj);
  if (!info)
  {
    info = {};
    infos.set(obj, info);
  }
  return info;
}

export function tagOf(v: any): string
{
  return Object.prototype.toString.call(v).slice(8, -1);
}

export const HANDLE_TYPES = new Set([
  'GPUAdapter', 'GPUDevice', 'GPUQueue', 'GPUBuffer', 'GPUTexture', 'GPUTextureView', 'GPUSampler',
  'GPUExternalTexture', 'GPUBindGroupLayout', 'GPUPipelineLayout', 'GPUBindGroup', 'GPUShaderModule',
  'GPUComputePipeline', 'GPURenderPipeline', 'GPUCommandBuffer', 'GPUCommandEncoder',
  'GPUComputePassEncoder', 'GPURenderPassEncoder', 'GPURenderBundle', 'GPURenderBundleEncoder',
  'GPUQuerySet', 'GPUCanvasContext'
]);

/** Prototypes of the handle types: a Set lookup is much cheaper than Object.prototype.toString. */
export const HANDLE_PROTOS = new Set<object>(
  [...HANDLE_TYPES].map((n) => (globalThis as any)[n]?.prototype).filter(Boolean)
);

export function isHandle(v: any): boolean
{
  return typeof v === 'object' && v !== null && HANDLE_PROTOS.has(Object.getPrototypeOf(v));
}
