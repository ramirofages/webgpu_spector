// A deliberately feature-heavy frame: offscreen pass sampled later, compute pass, MSAA main pass
// with resolve, dynamic offsets, debug groups, occlusion query, indirect draw and a render bundle.

const err = (m) => { document.getElementById('err').textContent += m + '\n'; };

const mat4 = {
  perspective(fovy, aspect, near, far)
  {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, far * near * nf, 0]);
  },
  mul(a, b)
  {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++)
      {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
    return o;
  },
  translate(x, y, z) { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]); },
  rotY(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); },
  rotX(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]); },
  scale(s) { return new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]); }
};

try
{
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice({ label: 'test device' });
  device.addEventListener('uncapturederror', (e) => err('GPU error: ' + e.error.message));
  const canvas = document.querySelector('canvas');
  const ctx = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });

  // Cube: interleaved position + normal, indexed.
  const P = [];
  const I = [];
  const faces = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
  for (const n of faces)
  {
    const [nx, ny, nz] = n;
    const u = Math.abs(ny) > 0.5 ? [1, 0, 0] : [0, 1, 0];
    const v = [ny * u[2] - nz * u[1], nz * u[0] - nx * u[2], nx * u[1] - ny * u[0]];
    const base = P.length / 6;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
    {
      P.push(nx + a * u[0] + b * v[0], ny + a * u[1] + b * v[1], nz + a * u[2] + b * v[2], nx, ny, nz);
    }
    I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const vbuf = device.createBuffer({ label: 'cube vertices', size: P.length * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vbuf, 0, new Float32Array(P));
  const ibuf = device.createBuffer({ label: 'cube indices', size: I.length * 2, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(ibuf, 0, new Uint16Array(I));

  const SLOT = 256;
  const N = 12;
  const ubuf = device.createBuffer({ label: 'object uniforms (dynamic)', size: SLOT * N, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  // Checker texture.
  const checker = device.createTexture({ label: 'checker', size: [64, 64], format: 'rgba8unorm-srgb', mipLevelCount: 1, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const px = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++)
    {
      const on = ((x >> 3) + (y >> 3)) & 1;
      px.set(on ? [240, 240, 240, 255] : [90, 140, 220, 255], (y * 64 + x) * 4);
    }
  device.queue.writeTexture({ texture: checker }, px, { bytesPerRow: 256 }, [64, 64]);
  const sampler = device.createSampler({ label: 'linear repeat', magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });

  const shader = device.createShaderModule({
    label: 'cube shader',
    code: /* wgsl */ `
struct Object {
  mvp: mat4x4f,
  color: vec4f,
  params: vec4f,
};
@group(0) @binding(0) var<uniform> obj: Object;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) normal: vec3f,
  @location(1) uv: vec2f,
};

@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f) -> VOut {
  var o: VOut;
  o.pos = obj.mvp * vec4f(position, 1.0);
  o.normal = normal;
  o.uv = position.xy * 0.5 + 0.5;
  return o;
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let l = max(dot(normalize(i.normal), normalize(vec3f(0.4, 0.8, 0.5))), 0.15);
  let t = textureSample(tex, samp, i.uv * obj.params.x);
  return vec4f(obj.color.rgb * t.rgb * l, 1.0);
}
`
  });

  const bgl = device.createBindGroupLayout({
    label: 'object layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 96 } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} }
    ]
  });
  const layout = device.createPipelineLayout({ label: 'object pipeline layout', bindGroupLayouts: [bgl] });
  const vbLayout = [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }];

  const mkCubePipeline = (label, fmt, depthFmt, samples) => device.createRenderPipeline({
    label,
    layout,
    vertex: { module: shader, entryPoint: 'vs', buffers: vbLayout },
    fragment: { module: shader, entryPoint: 'fs', targets: [{ format: fmt }] },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: { format: depthFmt, depthWriteEnabled: true, depthCompare: 'less' },
    multisample: { count: samples }
  });

  const cubeMain = mkCubePipeline('cube (main, msaa)', format, 'depth24plus', 4);
  const cubeOff = mkCubePipeline('cube (offscreen)', 'rgba16float', 'depth32float', 1);

  // Offscreen target, sampled by the quad in the main pass.
  const offColor = device.createTexture({ label: 'offscreen color', size: [256, 256], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  const offDepth = device.createTexture({ label: 'offscreen depth', size: [256, 256], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });

  const quadShader = device.createShaderModule({
    label: 'quad shader',
    code: /* wgsl */ `
struct Quad { rect: vec4f, tint: vec4f };
@group(0) @binding(0) var<uniform> q: Quad;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var img: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> wave: array<f32>;
struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  var c = array<vec2f, 6>(vec2f(0,0), vec2f(1,0), vec2f(1,1), vec2f(0,0), vec2f(1,1), vec2f(0,1));
  var o: V;
  let uv = c[i];
  o.p = vec4f(mix(q.rect.xy, q.rect.zw, uv), 0.0, 1.0);
  o.uv = vec2f(uv.x, 1.0 - uv.y);
  return o;
}
@fragment fn fs(v: V) -> @location(0) vec4f {
  let w = wave[u32(v.uv.x * 63.0)];
  let c = textureSample(img, samp, v.uv).rgb;
  let line = select(0.0, 1.0, abs(v.uv.y - (0.5 + 0.4 * w)) < 0.01);
  return vec4f(c * q.tint.rgb + vec3f(line), 1.0);
}
`
  });
  const quadPipeline = device.createRenderPipeline({
    label: 'quad (auto layout)',
    layout: 'auto',
    vertex: { module: quadShader, entryPoint: 'vs' },
    fragment: { module: quadShader, entryPoint: 'fs', targets: [{ format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} } }] },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
    multisample: { count: 4 }
  });

  // Compute: writes a wave into a storage buffer the quad reads.
  const waveBuf = device.createBuffer({ label: 'wave (storage)', size: 64 * 4, usage: GPUBufferUsage.STORAGE });
  const timeBuf = device.createBuffer({ label: 'time', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const compute = device.createComputePipeline({
    label: 'wave compute',
    layout: 'auto',
    compute: {
      module: device.createShaderModule({
        label: 'wave compute shader',
        code: /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> wave: array<f32>;
@group(0) @binding(1) var<uniform> time: vec4f;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  wave[id.x] = sin(f32(id.x) * 0.2 + time.x * 3.0);
}
`
      }),
      entryPoint: 'main'
    }
  });
  const computeBG = device.createBindGroup({ label: 'wave bind group', layout: compute.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: waveBuf } }, { binding: 1, resource: { buffer: timeBuf } }] });

  const quadU = device.createBuffer({ label: 'quad uniforms', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(quadU, 0, new Float32Array([0.35, 0.35, 0.95, 0.95, 1, 1, 1, 1]));
  const quadBG = device.createBindGroup({
    label: 'quad bind group',
    layout: quadPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: quadU } },
      { binding: 1, resource: sampler },
      { binding: 2, resource: offColor.createView({ label: 'offscreen color view' }) },
      { binding: 3, resource: { buffer: waveBuf } }
    ]
  });

  const objBG = device.createBindGroup({ label: 'object bind group', layout: bgl, entries: [{ binding: 0, resource: { buffer: ubuf, size: 96 } }, { binding: 1, resource: sampler }, { binding: 2, resource: checker.createView() }] });

  // Indirect args for one more cube.
  const indirect = device.createBuffer({ label: 'indirect args', size: 20, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(indirect, 0, new Uint32Array([36, 3, 0, 0, 0]));

  const querySet = device.createQuerySet({ label: 'occlusion', type: 'occlusion', count: 1 });
  const queryBuf = device.createBuffer({ label: 'occlusion results', size: 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });

  // Render bundle with two cubes (slots 10 and 11).
  const benc = device.createRenderBundleEncoder({ label: 'bundle encoder', colorFormats: [format], depthStencilFormat: 'depth24plus', sampleCount: 4 });
  benc.setPipeline(cubeMain);
  benc.setVertexBuffer(0, vbuf);
  benc.setIndexBuffer(ibuf, 'uint16');
  benc.setBindGroup(0, objBG, [SLOT * 10]);
  benc.drawIndexed(36);
  benc.setBindGroup(0, objBG, [SLOT * 11]);
  benc.drawIndexed(36, 2);
  const bundle = benc.finish({ label: 'two cubes bundle' });

  let msaa, depth, w = 0, h = 0;
  function ensureTargets()
  {
    const dpr = Math.min(devicePixelRatio, 2);
    const cw = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const ch = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (cw === w && ch === h) return;
    w = canvas.width = cw;
    h = canvas.height = ch;
    msaa?.destroy();
    depth?.destroy();
    msaa = device.createTexture({ label: 'main msaa color', size: [w, h], format, sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    depth = device.createTexture({ label: 'main depth', size: [w, h], format: 'depth24plus', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }

  const colors = [[1, 0.4, 0.3], [0.3, 1, 0.4], [0.3, 0.5, 1], [1, 0.9, 0.3], [0.9, 0.3, 1], [0.3, 1, 1], [1, 1, 1], [1, 0.6, 0.2], [0.6, 0.6, 0.6], [0.8, 0.2, 0.2], [0.2, 0.8, 0.2], [0.2, 0.2, 0.8]];

  function frame(t)
  {
    ensureTargets();
    const time = t / 1000;
    const proj = mat4.perspective(Math.PI / 3, w / h, 0.1, 100);
    const offProj = mat4.perspective(Math.PI / 3, 1, 0.1, 100);
    const data = new Float32Array((SLOT / 4) * N);
    for (let i = 0; i < N; i++)
    {
      const ang = (i / 8) * Math.PI * 2 + time * 0.5;
      let model;
      if (i < 8) model = mat4.mul(mat4.translate(Math.cos(ang) * 4, Math.sin(i * 1.3) * 0.8, -10 + Math.sin(ang) * 4), mat4.mul(mat4.rotY(time + i), mat4.scale(0.7)));
      else if (i < 10) model = mat4.mul(mat4.translate(i === 8 ? -1.2 : 1.2, 0, -4), mat4.mul(mat4.rotX(time), mat4.rotY(time * 1.3)));
      else model = mat4.mul(mat4.translate(i === 10 ? -2.5 : 2.5, -2.2, -7), mat4.rotY(-time));
      const mvp = mat4.mul(i === 8 || i === 9 ? offProj : proj, model);
      const o = i * (SLOT / 4);
      data.set(mvp, o);
      data.set([...colors[i], 1], o + 16);
      data.set([i < 8 ? 2 : 1, 0, 0, 0], o + 20);
    }
    device.queue.writeBuffer(ubuf, 0, data);
    device.queue.writeBuffer(timeBuf, 0, new Float32Array([time, 0, 0, 0]));

    const enc = device.createCommandEncoder({ label: 'frame encoder' });

    enc.pushDebugGroup('Simulation');
    const cp = enc.beginComputePass({ label: 'wave pass' });
    cp.setPipeline(compute);
    cp.setBindGroup(0, computeBG);
    cp.dispatchWorkgroups(1);
    cp.end();
    enc.popDebugGroup();

    const off = enc.beginRenderPass({
      label: 'offscreen pass',
      colorAttachments: [{ view: offColor.createView(), loadOp: 'clear', clearValue: [0.08, 0.05, 0.12, 1], storeOp: 'store' }],
      depthStencilAttachment: { view: offDepth.createView(), depthLoadOp: 'clear', depthClearValue: 1, depthStoreOp: 'discard' }
    });
    off.setPipeline(cubeOff);
    off.setVertexBuffer(0, vbuf);
    off.setIndexBuffer(ibuf, 'uint16');
    off.setBindGroup(0, objBG, [SLOT * 8]);
    off.drawIndexed(36);
    off.setBindGroup(0, objBG, [SLOT * 9]);
    off.drawIndexed(36);
    off.end();

    const pass = enc.beginRenderPass({
      label: 'main pass',
      colorAttachments: [{ view: msaa.createView(), resolveTarget: ctx.getCurrentTexture().createView(), loadOp: 'clear', clearValue: { r: 0.05, g: 0.06, b: 0.08, a: 1 }, storeOp: 'discard' }],
      depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthClearValue: 1, depthStoreOp: 'discard' },
      occlusionQuerySet: querySet
    });
    pass.pushDebugGroup('Ring of cubes');
    pass.setPipeline(cubeMain);
    pass.setVertexBuffer(0, vbuf);
    pass.setIndexBuffer(ibuf, 'uint16');
    for (let i = 0; i < 7; i++)
    {
      pass.setBindGroup(0, objBG, [SLOT * i]);
      if (i === 3) pass.beginOcclusionQuery(0);
      pass.drawIndexed(36);
      if (i === 3) pass.endOcclusionQuery();
    }
    pass.popDebugGroup();
    pass.setBindGroup(0, objBG, new Uint32Array([0, SLOT * 7, 0]), 1, 1);
    pass.drawIndexedIndirect(indirect, 0);
    pass.executeBundles([bundle]);
    pass.pushDebugGroup('Overlay');
    pass.setPipeline(quadPipeline);
    pass.setBindGroup(0, quadBG);
    pass.setViewport(0, 0, w, h, 0, 1);
    pass.draw(6);
    pass.popDebugGroup();
    pass.end();

    enc.resolveQuerySet(querySet, 0, 1, queryBuf, 0);
    device.queue.submit([enc.finish({ label: 'frame' })]);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
catch (e)
{
  err(String(e?.stack ?? e));
}
