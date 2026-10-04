// Unpatched WebGPU entry points. Everything the hook encodes for itself (blits, copies,
// readbacks) goes through these so it never shows up in the capture or gets re-instrumented.

type Fn = (...args: any[]) => any;

function grab(proto: any, names: string[]): Record<string, Fn>
{
  const out: Record<string, Fn> = {};
  for (const n of names)
  {
    const d = proto && Object.getOwnPropertyDescriptor(proto, n);
    if (d && typeof d.value === 'function') out[n] = d.value;
  }
  return out;
}

export const G = {
  dev: {} as Record<string, Fn>,
  tex: {} as Record<string, Fn>,
  buf: {} as Record<string, Fn>,
  enc: {} as Record<string, Fn>,
  rp: {} as Record<string, Fn>,
  queue: {} as Record<string, Fn>,
  shader: {} as Record<string, Fn>
};

export function captureOriginals(): void
{
  G.dev = grab(GPUDevice.prototype, [
    'createBuffer', 'createTexture', 'createBindGroup', 'createBindGroupLayout', 'createPipelineLayout',
    'createShaderModule', 'createRenderPipeline', 'createCommandEncoder', 'pushErrorScope', 'popErrorScope'
  ]);
  G.tex = grab(GPUTexture.prototype, ['createView', 'destroy']);
  G.buf = grab(GPUBuffer.prototype, ['mapAsync', 'getMappedRange', 'unmap', 'destroy']);
  G.enc = grab(GPUCommandEncoder.prototype, ['beginRenderPass', 'copyBufferToBuffer', 'copyTextureToBuffer', 'finish']);
  G.rp = grab(GPURenderPassEncoder.prototype, [
    'setPipeline', 'setBindGroup', 'setVertexBuffer', 'setIndexBuffer', 'setViewport', 'setScissorRect',
    'setBlendConstant', 'setStencilReference', 'draw', 'end', 'pushDebugGroup', 'popDebugGroup', 'executeBundles'
  ]);
  G.queue = grab(GPUQueue.prototype, ['submit', 'onSubmittedWorkDone', 'writeBuffer']);
  G.shader = grab(GPUShaderModule.prototype, ['getCompilationInfo']);
}

export const BU = {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100
};

export const TU = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
  TRANSIENT_ATTACHMENT: 0x20
};
