// Measures CPU time spent in WebGPU calls with and without the hook installed (idle: no capture).
import * as THREE from 'three/webgpu';

const out = document.getElementById('out');
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const results = { hook: window.__HOOK };

async function rawBench()
{
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const module = device.createShaderModule({ code: `
    @group(0) @binding(0) var<uniform> u: vec4f;
    @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(vec2f(0, 0.01), vec2f(-0.01, -0.01), vec2f(0.01, -0.01));
      return vec4f(p[i] + u.xy, 0, 1);
    }
    @fragment fn fs() -> @location(0) vec4f { return vec4f(1); }` });
  const bgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { hasDynamicOffset: true } }] });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] }
  });
  const ub = device.createBuffer({ size: 256 * 1000, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bg = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: ub, size: 16 } }] });
  const target = device.createTexture({ size: [256, 256], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const view = target.createView();
  const offsets = Array.from({ length: 1000 }, (_, i) => [i * 256]);

  const DRAWS = 10000;
  const times = [];
  for (let it = 0; it < 120; it++)
  {
    const t = performance.now();
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    for (let i = 0; i < DRAWS; i++)
    {
      pass.setBindGroup(0, bg, offsets[i % 1000]);
      pass.draw(3);
    }
    pass.end();
    device.queue.submit([enc.finish()]);
    if (it >= 20) times.push(performance.now() - t);
    if (it % 10 === 9) await device.queue.onSubmittedWorkDone();
  }
  results.rawEncodeMs = median(times);
  results.rawPerCallNs = (median(times) * 1e6) / (DRAWS * 2);

  // Object creation (always tracked, even when idle).
  let t = performance.now();
  for (let i = 0; i < 5000; i++) device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: ub, offset: (i % 1000) * 256, size: 16 } }] });
  results.createBindGroupUs = ((performance.now() - t) * 1000) / 5000;
  t = performance.now();
  for (let i = 0; i < 5000; i++) target.createView({ baseMipLevel: 0 });
  results.createViewUs = ((performance.now() - t) * 1000) / 5000;
  t = performance.now();
  for (let i = 0; i < 2000; i++) device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }).destroy();
  results.createBufferUs = ((performance.now() - t) * 1000) / 2000;
  device.destroy();
}

async function threeBench()
{
  const canvas = document.getElementById('c');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.setSize(256, 256, false);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  camera.position.set(0, 0, 60);
  scene.add(new THREE.DirectionalLight(0xffffff, 2), new THREE.AmbientLight(0x404040));
  const geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const mats = Array.from({ length: 8 }, (_, i) => new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(i / 8, 0.6, 0.5) }));
  const meshes = [];
  for (let i = 0; i < 2000; i++)
  {
    const m = new THREE.Mesh(geo, mats[i % 8]);
    m.position.set((i % 50) - 25, Math.floor(i / 50) - 20, 0);
    scene.add(m);
    meshes.push(m);
  }
  const times = [];
  for (let f = 0; f < 140; f++)
  {
    for (const m of meshes) m.rotation.y = f * 0.05;
    const t = performance.now();
    renderer.render(scene, camera);
    if (f >= 40) times.push(performance.now() - t);
    if (f % 10 === 9) await new Promise((r) => setTimeout(r, 0));
  }
  results.threeRenderMs = median(times);
  results.threeDrawCalls = renderer.info.render.drawCalls;
}

await rawBench();
await threeBench();
window.__bench = results;
out.textContent = JSON.stringify(results, null, 2);
