// Right-hand panel of the Commands view: everything about the selected command.

import type { CmdJSON, DrawState } from '../shared/protocol';
import { refId, type Ctx, type ShaderStageRef } from './ctx';
import { readVertex, reflectModule, vertexFormatSize } from './decode';
import { append, fmtNum, h, kv, section, type Child } from './dom';
import { cmdLabel, type TreeNode } from './model';
import {
  decodeStruct,
  fieldTable,
  imageBox,
  later,
  loadBufferSnapshot,
  ptree,
  rawViewer,
  refLink,
  samplerSummary,
  texSummary,
  textureOfView,
  viewAt
} from './widgets';

const DRAW_ARG_NAMES: Record<string, string[]> = {
  draw: ['vertexCount', 'instanceCount', 'firstVertex', 'firstInstance'],
  drawIndexed: ['indexCount', 'instanceCount', 'firstIndex', 'baseVertex', 'firstInstance'],
  drawIndirect: ['indirectBuffer', 'indirectOffset'],
  drawIndexedIndirect: ['indirectBuffer', 'indirectOffset'],
  multiDrawIndirect: ['indirectBuffer', 'indirectOffset', 'maxDrawCount', 'drawCountBuffer', 'drawCountBufferOffset'],
  multiDrawIndexedIndirect: ['indirectBuffer', 'indirectOffset', 'maxDrawCount', 'drawCountBuffer', 'drawCountBufferOffset'],
  dispatchWorkgroups: ['workgroupCountX', 'workgroupCountY', 'workgroupCountZ'],
  dispatchWorkgroupsIndirect: ['indirectBuffer', 'indirectOffset']
};

const DRAW_DEFAULTS: Record<string, number[]> = {
  draw: [0, 1, 0, 0],
  drawIndexed: [0, 1, 0, 0, 0],
  dispatchWorkgroups: [1, 1, 1]
};

export function renderDetails(ctx: Ctx, node: TreeNode): HTMLElement
{
  const el = h('div', { class: 'details' });
  const c = node.cmd;
  const title = c ? cmdLabel(ctx.cap, c) : node.label;
  el.append(h('h2', null, node.kind === 'pass' || node.kind === 'submit' || node.kind === 'cb' || node.kind === 'group' || node.kind === 'bundle' ? node.label : title));

  const sub: string[] = [];
  if (node.drawNo) sub.push(`${node.isDispatch ? 'Dispatch' : 'Draw'} #${node.drawNo}`);
  if (node.pass && node.kind !== 'pass') sub.push(node.pass.label);
  if (node.bundle !== undefined) sub.push('inside a render bundle');
  if (sub.length) el.append(h('div', { class: 'subtitle' }, sub.join(' · ')));

  switch (node.kind)
  {
    case 'pass': passDetails(ctx, node, el); break;
    case 'submit': submitDetails(ctx, node, el); break;
    case 'cb': el.append(kv([['Encoder', node.encoder ? `#${node.encoder.id}` : ''], ['Label', node.encoder?.label || ''], ['Commands', String(node.encoder?.cmds.length ?? 0)]])); break;
    case 'group': groupDetails(ctx, node, el); break;
    case 'bundle': bundleDetails(ctx, node, el); break;
    default:
      if (c?.draw) drawDetails(ctx, node, c, el);
      else if (c) commandDetails(ctx, node, c, el);
  }
  return el;
}

// ---------------------------------------------------------------------------

function stackSection(ctx: Ctx, c: CmdJSON | undefined): HTMLElement | null
{
  if (c?.st === undefined) return null;
  const s = ctx.cap.meta.stacks[c.st];
  if (!s) return null;
  return section('JS stack', h('pre', { class: 'stack' }, s), { key: 'stack', collapsed: true });
}

function outputImages(ctx: Ctx, node: TreeNode, snaps: any, label: string): HTMLElement
{
  const colors: (number | null)[] = snaps.c ?? [];
  const box = h('div', { class: 'images' });
  colors.forEach((id, i) =>
  {
    box.append(imageBox(ctx, id, { size: 'big', title: `${label} · color ${i}`, caption: h('span', null, h('b', null, `Color ${i}`), ' · ', captionFor(ctx, id)) }));
  });
  if (snaps.d !== undefined && snaps.d !== null)
  {
    box.append(imageBox(ctx, snaps.d, { size: colors.length ? 'small' : 'big', title: `${label} · depth`, caption: h('span', null, h('b', null, 'Depth'), ' · ', captionFor(ctx, snaps.d)) }));
  }
  return box;
}

function captionFor(ctx: Ctx, id: number | null): string
{
  if (id === null) return 'not captured';
  const m = ctx.cap.snapshots[id];
  if (!m) return '';
  const parts = [m.format, `${m.srcWidth}×${m.srcHeight}`];
  if (m.sampleCount > 1) parts.push(`MSAA ×${m.sampleCount}`);
  if (m.kind === 'depth' && m.depthMin !== undefined) parts.push(`range ${fmtNum(m.depthMin)}…${fmtNum(m.depthMax!)}`);
  return parts.join(' · ');
}

/** The closest earlier visual state in the same pass (what the target looked like before). */
function previousSnap(ctx: Ctx, node: TreeNode): any
{
  const vs = ctx.model.visual;
  const i = vs.findIndex((v) => v.node === node);
  if (i > 0 && vs[i - 1].pass === node.pass) return vs[i - 1];
  return null;
}

function drawDetails(ctx: Ctx, node: TreeNode, c: CmdJSON, el: HTMLElement): void
{
  const state = c.draw!.state as DrawState;
  const cap = ctx.cap;
  const pipeline = ctx.obj(state?.pipeline);
  const isCompute = node.isDispatch;

  // Output
  if (node.snap)
  {
    const prev = previousSnap(ctx, node);
    el.append(section('Output after this call', () => h('div', null,
      outputImages(ctx, node, node.snap, node.label),
      prev ? h('div', { style: 'margin-top:8px' }, h('span', { class: 'chip' }, 'Before'), ' ',
        h('a', { href: '#', on: { click: (e: Event) => { e.preventDefault(); ctx.selectNode(prev.node, true); } } }, prev.passEnd ? 'previous pass end' : prev.node.label)) : null
    ), { key: 'output' }));
  }
  else if (!isCompute && node.bundle === undefined)
  {
    el.append(section('Output after this call', h('div', { class: 'note' }, 'No image for this draw (snapshots disabled, budget reached, or deferred by an occlusion query).'), { key: 'output' }));
  }

  // Arguments
  if (c.n !== 'executeBundles')
  {
    el.append(section('Arguments', () => drawArgs(ctx, node, c), { key: 'args' }));
  }
  else
  {
    el.append(section('Bundles', () => h('div', null, (c.a?.[0] ?? []).map((r: any, i: number) =>
      h('div', { style: 'margin-bottom:8px' }, refLink(ctx, r), ' ', c.draw?.bundleSnaps?.[i]
        ? imageBox(ctx, c.draw.bundleSnaps[i].c?.[0], { size: 'tiny' }) : null)
    )), { key: 'bundles' }));
  }

  const stack = stackSection(ctx, c);
  if (stack) el.append(stack);

  if (!pipeline)
  {
    if (c.n !== 'executeBundles') el.append(h('div', { class: 'note' }, 'No pipeline set.'));
    return;
  }

  const stages = pipelineStages(pipeline);
  el.append(section(isCompute ? 'Compute pipeline' : 'Pipeline', () => pipelineView(ctx, pipeline, stages), {
    key: 'pipeline',
    extra: shaderButtons(ctx, stages)
  }));

  // Bind groups
  el.append(section(`Bind groups (${state.bindGroups.length})`, () => h('div', null,
    state.bindGroups.map((g) => bindGroupCard(ctx, node, g, stages))
  ), { key: 'bindgroups' }));

  if (!isCompute)
  {
    if (state.vertexBuffers.length || pipeline.desc?.vertex?.buffers?.length)
    {
      el.append(section(`Vertex buffers (${state.vertexBuffers.length})`, () => vertexBuffersView(ctx, node, c, state, pipeline, stages), { key: 'vbs' }));
    }
    if (state.indexBuffer)
    {
      el.append(section('Index buffer', () => indexBufferView(ctx, node, c, state), { key: 'ib' }));
    }
    el.append(section('Render pass & dynamic state', () => h('div', null,
      attachmentsTable(ctx, node.pass?.begin.a?.[0]),
      kv([
        ['Viewport', state.viewport ? state.viewport.map(fmtNum).join(', ') : 'full target'],
        ['Scissor', state.scissor ? state.scissor.join(', ') : 'full target'],
        ['Blend constant', state.blendConstant ? ptree(ctx, state.blendConstant) : ''],
        ['Stencil reference', state.stencilReference !== null && state.stencilReference !== undefined ? String(state.stencilReference) : '']
      ])
    ), { key: 'passstate', collapsed: true }));
  }
}

function drawArgs(ctx: Ctx, node: TreeNode, c: CmdJSON): HTMLElement
{
  const names = DRAW_ARG_NAMES[c.n] ?? [];
  const defs = DRAW_DEFAULTS[c.n] ?? [];
  const args = c.a ?? [];
  const rows: [string, Child][] = names.map((n, i) =>
  {
    const v = args[i] ?? defs[i];
    if (v === undefined) return [n, ''];
    if (refId(v) !== undefined) return [n, refLink(ctx, v)];
    return [n, typeof v === 'number' ? String(v) : ptree(ctx, v)];
  });
  const box = h('div', null, kv(rows));
  if (c.n.includes('Indirect') && refId(args[0]) !== undefined && node.pass)
  {
    const bufId = refId(args[0])!;
    const snapId = node.pass.json.bufSnaps[bufId];
    const fields = c.n === 'drawIndirect' || c.n === 'multiDrawIndirect'
      ? ['vertexCount', 'instanceCount', 'firstVertex', 'firstInstance']
      : c.n.startsWith('dispatch') ? ['x', 'y', 'z'] : ['indexCount', 'instanceCount', 'firstIndex', 'baseVertex', 'firstInstance'];
    box.append(h('div', { style: 'margin-top:6px' }, later(loadBufferSnapshot(ctx, snapId).then((data) =>
    {
      if (!data) return h('span', { class: 'note' }, 'Indirect buffer contents not captured.');
      const dv = viewAt(data, args[1] ?? 0, fields.length * 4);
      if (!dv) return h('span', { class: 'note' }, 'Indirect args not in the captured range.');
      return kv(fields.map((f, i) => [`→ ${f}`, String(f === 'baseVertex' ? dv.getInt32(i * 4, true) : dv.getUint32(i * 4, true))]));
    }))));
  }
  return box;
}

// ---------------------------------------------------------------------------
// Pipeline

export function pipelineStages(pipeline: any): ShaderStageRef[]
{
  const d = pipeline?.desc ?? {};
  const out: ShaderStageRef[] = [];
  if (d.vertex?.module) out.push({ stage: 'vertex', module: refId(d.vertex.module)!, entryPoint: d.vertex.entryPoint });
  if (d.fragment?.module) out.push({ stage: 'fragment', module: refId(d.fragment.module)!, entryPoint: d.fragment.entryPoint });
  if (d.compute?.module) out.push({ stage: 'compute', module: refId(d.compute.module)!, entryPoint: d.compute.entryPoint });
  return out.filter((s) => s.module !== undefined);
}

function shaderButtons(ctx: Ctx, stages: ShaderStageRef[]): HTMLElement
{
  return h('span', { style: 'display:inline-flex;gap:4px' }, stages.map((s, i) =>
    h('button', { class: 'btn small', on: { click: () => ctx.openShader(stages, i) } }, `${s.stage} shader`)
  ));
}

function blendText(b: any): string
{
  if (!b) return 'none';
  const f = (c: any) => c ? `${c.srcFactor ?? 'one'} ${c.operation ?? 'add'} ${c.dstFactor ?? 'zero'}` : 'one add zero';
  return `color: ${f(b.color)}  ·  alpha: ${f(b.alpha)}`;
}

function writeMaskText(m: any): string
{
  if (m === undefined) return 'RGBA';
  const s = `${m & 1 ? 'R' : ''}${m & 2 ? 'G' : ''}${m & 4 ? 'B' : ''}${m & 8 ? 'A' : ''}`;
  return s || 'none';
}

export function pipelineView(ctx: Ctx, pipeline: any, stages: ShaderStageRef[]): HTMLElement
{
  const d = pipeline.desc ?? {};
  const el = h('div', null);
  el.append(kv([
    ['Pipeline', refLink(ctx, { $ref: pipeline.id })],
    ['Layout', d.layout === 'auto' ? 'auto' : d.layout ? refLink(ctx, d.layout) : ''],
    ...stages.map((s): [string, Child] => [
      `${s.stage[0].toUpperCase()}${s.stage.slice(1)}`,
      h('span', null, refLink(ctx, { $ref: s.module }), s.entryPoint ? h('span', { class: 'chip', style: 'margin-left:6px' }, `entry ${s.entryPoint}`) : null)
    ]),
    ['Async', pipeline.async ? 'created with createRenderPipelineAsync' : '']
  ]));

  if (d.primitive || d.vertex)
  {
    const p = d.primitive ?? {};
    el.append(h('div', { style: 'margin-top:8px' }, kv([
      ['Topology', p.topology ?? 'triangle-list'],
      ['Cull mode', p.cullMode ?? 'none'],
      ['Front face', p.frontFace ?? 'ccw'],
      ['Strip index format', p.stripIndexFormat ?? ''],
      ['Unclipped depth', p.unclippedDepth ? 'true' : '']
    ])));
  }
  if (d.depthStencil)
  {
    const ds = d.depthStencil;
    el.append(h('div', { style: 'margin-top:8px' }, kv([
      ['Depth format', ds.format],
      ['Depth write', String(ds.depthWriteEnabled ?? false)],
      ['Depth compare', ds.depthCompare ?? 'always'],
      ['Depth bias', ds.depthBias ? `${ds.depthBias} (slope ${ds.depthBiasSlopeScale ?? 0}, clamp ${ds.depthBiasClamp ?? 0})` : ''],
      ['Stencil front', ds.stencilFront ? ptree(ctx, ds.stencilFront) : ''],
      ['Stencil back', ds.stencilBack ? ptree(ctx, ds.stencilBack) : ''],
      ['Stencil masks', ds.stencilReadMask !== undefined || ds.stencilWriteMask !== undefined ? `read 0x${(ds.stencilReadMask ?? 0xffffffff).toString(16)} write 0x${(ds.stencilWriteMask ?? 0xffffffff).toString(16)}` : '']
    ])));
  }
  if (d.multisample && (d.multisample.count ?? 1) > 1)
  {
    el.append(h('div', { style: 'margin-top:8px' }, kv([
      ['Multisample', `${d.multisample.count}×`],
      ['Alpha to coverage', d.multisample.alphaToCoverageEnabled ? 'on' : 'off'],
      ['Sample mask', d.multisample.mask !== undefined ? `0x${(d.multisample.mask >>> 0).toString(16)}` : '']
    ])));
  }
  const targets: any[] = d.fragment?.targets ?? [];
  if (targets.length)
  {
    el.append(h('table', { class: 'grid', style: 'margin-top:8px' },
      h('tr', null, h('th', null, '#'), h('th', null, 'Format'), h('th', null, 'Blend'), h('th', null, 'Write mask')),
      targets.map((t, i) => t
        ? h('tr', null, h('td', null, String(i)), h('td', { class: 'mono' }, t.format), h('td', { class: 'mono' }, blendText(t.blend)), h('td', { class: 'mono' }, writeMaskText(t.writeMask)))
        : h('tr', null, h('td', null, String(i)), h('td', { colSpan: 3 }, 'unused')))
    ));
  }
  const consts = { ...(d.vertex?.constants ?? {}), ...(d.fragment?.constants ?? {}), ...(d.compute?.constants ?? {}) };
  if (Object.keys(consts).length) el.append(h('div', { style: 'margin-top:8px' }, kv([['Overrides', ptree(ctx, consts)]])));
  return el;
}

// ---------------------------------------------------------------------------
// Bind groups

function bindingKind(layoutEntry: any, resObj: any, reflectVar: any): string
{
  if (layoutEntry?.buffer) return `${layoutEntry.buffer.type ?? 'uniform'} buffer${layoutEntry.buffer.hasDynamicOffset ? ' (dynamic)' : ''}`;
  if (layoutEntry?.sampler) return `sampler${layoutEntry.sampler.type && layoutEntry.sampler.type !== 'filtering' ? ` (${layoutEntry.sampler.type})` : ''}`;
  if (layoutEntry?.texture) return `texture (${layoutEntry.texture.sampleType ?? 'float'}, ${layoutEntry.texture.viewDimension ?? '2d'}${layoutEntry.texture.multisampled ? ', ms' : ''})`;
  if (layoutEntry?.storageTexture) return `storage texture (${layoutEntry.storageTexture.access ?? 'write-only'}, ${layoutEntry.storageTexture.format})`;
  if (layoutEntry?.externalTexture) return 'external texture';
  if (reflectVar?.type) return reflectVar.type.getTypeName ? reflectVar.type.getTypeName() : reflectVar.type.name;
  if (resObj?.type === 'GPUSampler') return 'sampler';
  if (resObj?.type === 'GPUTextureView' || resObj?.type === 'GPUTexture') return 'texture';
  if (resObj?.type === 'GPUExternalTexture') return 'external texture';
  return 'buffer';
}

function findReflectVar(ctx: Ctx, stages: ShaderStageRef[], group: number, binding: number): { v: any; stage: ShaderStageRef } | null
{
  for (const s of stages)
  {
    const r = reflectModule(ctx.cap, s.module);
    const v = r?.findResource(group, binding);
    if (v) return { v, stage: s };
  }
  return null;
}

function dynamicIndexMap(layout: any): Map<number, number>
{
  const out = new Map<number, number>();
  const entries: any[] = layout?.desc?.entries ?? [];
  entries.filter((e) => e?.buffer?.hasDynamicOffset).sort((a, b) => a.binding - b.binding).forEach((e, i) => out.set(e.binding, i));
  return out;
}

export function bindGroupCard(ctx: Ctx, node: TreeNode | null, g: { index: number; bindGroup: any; offsets: number[] }, stages: ShaderStageRef[]): HTMLElement
{
  const bg = ctx.obj(g.bindGroup);
  const layout = ctx.obj(bg?.desc?.layout);
  const dyn = dynamicIndexMap(layout);
  const card = h('div', { class: 'bg-card' });
  card.append(h('div', { class: 'bg-head' },
    h('span', { class: 'gi' }, `@group(${g.index})`),
    g.bindGroup ? refLink(ctx, g.bindGroup) : h('span', { class: 'nul' }, 'unset'),
    layout ? h('span', { class: 'chip' }, layout.auto ? 'auto layout' : 'explicit layout') : null,
    g.offsets?.length ? h('span', { class: 'chip' }, `dynamic offsets [${g.offsets.join(', ')}]`) : null
  ));
  const body = h('div', { class: 'bg-body' });
  card.append(body);
  if (!bg) return card;

  const entries: any[] = [...(bg.desc?.entries ?? [])].sort((a, b) => a.binding - b.binding);
  for (const e of entries)
  {
    const res = e.resource;
    const resId = refId(res);
    const resObj = resId !== undefined ? ctx.cap.objects[resId] : null;
    const layoutEntry = (layout?.desc?.entries ?? []).find((x: any) => x.binding === e.binding);
    const rv = findReflectVar(ctx, stages, g.index, e.binding);
    const name = rv?.v?.name;

    const row = h('div', { class: 'binding' });
    const head = h('div', { class: 'bh' },
      h('span', { class: 'bn' }, `@${e.binding}`),
      name ? h('span', { class: 'name', title: `declared in the ${rv!.stage.stage} shader` }, name) : null,
      h('span', { class: 'chip' }, bindingKind(layoutEntry, resObj, rv?.v))
    );
    row.append(head);
    const bb = h('div', { class: 'bb' });

    if (resObj?.type === 'GPUSampler')
    {
      head.append(refLink(ctx, res));
      bb.append(h('div', { class: 'mono' }, samplerSummary(resObj.desc)));
    }
    else if (resObj?.type === 'GPUTextureView' || resObj?.type === 'GPUTexture')
    {
      const tex = textureOfView(ctx, res);
      head.append(refLink(ctx, tex ? { $ref: tex.id } : res));
      const snapId = node?.pass?.json.texSnaps[String(resId)];
      const r = resObj.resolved;
      const viewNote = r && (r.dimension !== '2d' || r.baseMipLevel || r.baseArrayLayer || r.mipLevelCount < (tex?.mipLevelCount ?? 1))
        ? `view: ${r.dimension}, mips ${r.baseMipLevel}+${r.mipLevelCount}, layers ${r.baseArrayLayer}+${r.arrayLayerCount}${r.format !== tex?.format ? `, ${r.format}` : ''}`
        : '';
      bb.append(h('div', { style: 'display:flex;gap:10px;align-items:flex-start' },
        snapId !== undefined ? imageBox(ctx, snapId, { size: 'small', caption: '' }) : null,
        h('div', null,
          h('div', { class: 'mono' }, texSummary(tex)),
          viewNote ? h('div', { class: 'mono', style: 'color:var(--muted)' }, viewNote) : null,
          snapId === undefined ? h('div', { class: 'note' }, 'No preview (texture snapshots off, or not sampleable).') : null,
          r && (r.dimension === 'cube' || r.dimension === 'cube-array') ? h('div', { class: 'chip' }, 'preview shows face 0') : null
        )
      ));
    }
    else if (resObj?.type === 'GPUExternalTexture')
    {
      head.append(refLink(ctx, res));
      bb.append(ptree(ctx, resObj.desc));
    }
    else
    {
      // Buffer binding: { buffer, offset, size } or a GPUBuffer directly.
      const bufRef = resObj?.type === 'GPUBuffer' ? res : res?.buffer;
      const buf = ctx.obj(bufRef);
      const baseOffset = resObj?.type === 'GPUBuffer' ? 0 : res?.offset ?? 0;
      const di = dyn.get(e.binding);
      const dynOff = di !== undefined ? g.offsets?.[di] ?? 0 : 0;
      const offset = baseOffset + dynOff;
      const size = (resObj?.type === 'GPUBuffer' ? undefined : res?.size) ?? (buf ? buf.size - baseOffset : 0);
      append(head, [bufRef ? refLink(ctx, bufRef) : null, h('span', { class: 'chip' }, `offset ${offset}${dynOff ? ` (${baseOffset}+${dynOff})` : ''}, ${size} B`)]);
      const snapId = buf && node?.pass ? node.pass.json.bufSnaps[String(buf.id)] : undefined;
      bb.append(later(loadBufferSnapshot(ctx, snapId).then((data) =>
      {
        if (!data || !data.ranges.length) return h('span', { class: 'note' }, data?.missing ?? 'Contents not captured (buffer snapshots off, or over budget).');
        const type = rv?.v?.type;
        if (type)
        {
          const f = decodeStruct(type, data, offset, size, name ?? '');
          if (f) return h('div', null, fieldTable(f), h('details', null, h('summary', { style: 'cursor:pointer;color:var(--muted);font-size:12px' }, 'raw'), rawViewer(data, offset, size)));
        }
        return rawViewer(data, offset, size);
      })));
    }
    row.append(bb);
    body.append(row);
  }
  return card;
}

// ---------------------------------------------------------------------------
// Vertex & index buffers

function vertexBuffersView(ctx: Ctx, node: TreeNode, c: CmdJSON, state: DrawState, pipeline: any, stages: ShaderStageRef[]): HTMLElement
{
  const layouts: any[] = pipeline.desc?.vertex?.buffers ?? [];
  const vstage = stages.find((s) => s.stage === 'vertex');
  const names = new Map<number, string>();
  if (vstage)
  {
    const r = reflectModule(ctx.cap, vstage.module);
    const fn = r?.entry.vertex.find((f: any) => !vstage.entryPoint || f.name === vstage.entryPoint) ?? r?.entry.vertex[0];
    for (const inp of fn?.inputs ?? []) if (inp.locationType === 'location') names.set(Number(inp.location), inp.name);
  }
  const el = h('div', null);
  layouts.forEach((lay, slot) =>
  {
    if (!lay) return;
    const vb = state.vertexBuffers.find((v) => v.slot === slot);
    const attrs: any[] = [...(lay.attributes ?? [])].sort((a, b) => a.offset - b.offset);
    const card = h('div', { class: 'bg-card' },
      h('div', { class: 'bg-head' },
        h('span', { class: 'gi' }, `slot ${slot}`),
        vb?.buffer ? refLink(ctx, vb.buffer) : h('span', { class: 'note' }, 'no buffer set'),
        h('span', { class: 'chip' }, `stride ${lay.arrayStride}`),
        h('span', { class: 'chip' }, lay.stepMode ?? 'vertex'),
        vb ? h('span', { class: 'chip' }, `offset ${vb.offset}`) : null
      ),
      h('div', { class: 'bg-body' },
        h('table', { class: 'grid' },
          h('tr', null, h('th', null, 'Location'), h('th', null, 'Name'), h('th', null, 'Format'), h('th', null, 'Offset')),
          attrs.map((a) => h('tr', null, h('td', null, String(a.shaderLocation)), h('td', { class: 'mono' }, names.get(a.shaderLocation) ?? ''), h('td', { class: 'mono' }, a.format), h('td', null, String(a.offset))))
        )
      )
    );
    if (vb?.buffer && node.pass)
    {
      const snapId = node.pass.json.bufSnaps[String(refId(vb.buffer))];
      const start = lay.stepMode === 'instance' ? Number(c.a?.[c.n === 'drawIndexed' ? 4 : 3] ?? 0) : c.n === 'draw' ? Number(c.a?.[2] ?? 0) : c.n === 'drawIndexed' ? Number(c.a?.[3] ?? 0) : 0;
      const body = card.querySelector('.bg-body')!;
      const btn = h('button', { class: 'btn small', style: 'margin-top:6px' }, `Show ${lay.stepMode === 'instance' ? 'instances' : 'vertices'} from ${start}`);
      btn.addEventListener('click', () =>
      {
        btn.replaceWith(later(loadBufferSnapshot(ctx, snapId).then((data) =>
        {
          if (!data) return h('span', { class: 'note' }, 'Contents not captured.');
          const rows: HTMLElement[] = [];
          const COUNT = 64;
          for (let i = start; i < start + COUNT; i++)
          {
            const base = vb.offset + i * lay.arrayStride;
            const cells = attrs.map((a) =>
            {
              const dv = viewAt(data, base + a.offset, vertexFormatSize(a.format));
              if (!dv) return h('td', { class: 'mono nul' }, '—');
              return h('td', { class: 'mono' }, readVertex(dv, 0, a.format).map((x) => (typeof x === 'number' ? fmtNum(x) : x)).join(', '));
            });
            if (cells.every((td) => td.textContent === '—')) break;
            rows.push(h('tr', null, h('td', { class: 'mono' }, String(i)), cells));
          }
          return h('div', { style: 'overflow:auto;max-height:340px;margin-top:6px' },
            h('table', { class: 'grid' }, h('tr', null, h('th', null, '#'), attrs.map((a) => h('th', null, names.get(a.shaderLocation) ?? `@${a.shaderLocation}`))), rows));
        })));
      });
      body.append(btn);
    }
    el.append(card);
  });
  return el;
}

function indexBufferView(ctx: Ctx, node: TreeNode, c: CmdJSON, state: DrawState): HTMLElement
{
  const ib = state.indexBuffer!;
  const el = h('div', null, kv([
    ['Buffer', refLink(ctx, ib.buffer)],
    ['Format', ib.format],
    ['Offset', String(ib.offset)],
    ['Size', ib.size !== undefined ? String(ib.size) : 'rest of buffer']
  ]));
  if (node.pass)
  {
    const snapId = node.pass.json.bufSnaps[String(refId(ib.buffer))];
    const first = c.n === 'drawIndexed' ? Number(c.a?.[2] ?? 0) : 0;
    const count = c.n === 'drawIndexed' ? Number(c.a?.[0] ?? 0) : 96;
    el.append(h('div', { style: 'margin-top:6px' }, later(loadBufferSnapshot(ctx, snapId).then((data) =>
    {
      if (!data) return h('span', { class: 'note' }, 'Contents not captured.');
      const sz = ib.format === 'uint32' ? 4 : 2;
      const n = Math.min(count, 192);
      const dv = viewAt(data, ib.offset + first * sz, n * sz);
      if (!dv) return h('span', { class: 'note' }, 'Index range not captured.');
      const vals: number[] = [];
      for (let i = 0; i + sz <= dv.byteLength && vals.length < n; i += sz) vals.push(sz === 4 ? dv.getUint32(i, true) : dv.getUint16(i, true));
      const tris: string[] = [];
      for (let i = 0; i < vals.length; i += 3) tris.push(vals.slice(i, i + 3).join(' '));
      return h('div', null,
        h('div', { class: 'chip' }, `indices ${first}…${first + vals.length - 1}${count > n ? ` of ${count}` : ''}, min ${Math.min(...vals)}, max ${Math.max(...vals)}`),
        h('div', { class: 'hexview', style: 'margin-top:4px' }, tris.join('   ')));
    }))));
  }
  return el;
}

// ---------------------------------------------------------------------------
// Passes & other commands

export function attachmentsTable(ctx: Ctx, desc: any): HTMLElement
{
  if (!desc) return h('div');
  const rows: HTMLElement[] = [];
  (desc.colorAttachments ?? []).forEach((a: any, i: number) =>
  {
    if (!a) return;
    const tex = textureOfView(ctx, a.view);
    const rt = a.resolveTarget ? textureOfView(ctx, a.resolveTarget) : null;
    rows.push(h('tr', null,
      h('td', null, `color ${i}`),
      h('td', null, tex ? refLink(ctx, { $ref: tex.id }) : refLink(ctx, a.view), h('div', { class: 'mono', style: 'color:var(--muted)' }, texSummary(tex))),
      h('td', { class: 'mono' }, `${a.loadOp}${a.loadOp === 'clear' && a.clearValue ? ` ${fmtColor(a.clearValue)}` : ''}`),
      h('td', { class: 'mono' }, a.storeOp),
      h('td', null, rt ? h('span', null, 'resolve → ', refLink(ctx, { $ref: rt.id })) : '')
    ));
  });
  const ds = desc.depthStencilAttachment;
  if (ds)
  {
    const tex = textureOfView(ctx, ds.view);
    rows.push(h('tr', null,
      h('td', null, 'depth/stencil'),
      h('td', null, tex ? refLink(ctx, { $ref: tex.id }) : refLink(ctx, ds.view), h('div', { class: 'mono', style: 'color:var(--muted)' }, texSummary(tex))),
      h('td', { class: 'mono' }, ds.depthReadOnly ? 'read-only' : `${ds.depthLoadOp ?? ''}${ds.depthLoadOp === 'clear' ? ` ${ds.depthClearValue ?? ''}` : ''}${ds.stencilLoadOp ? ` / ${ds.stencilLoadOp}` : ''}`),
      h('td', { class: 'mono' }, ds.depthReadOnly ? '' : `${ds.depthStoreOp ?? ''}${ds.stencilStoreOp ? ` / ${ds.stencilStoreOp}` : ''}`),
      h('td', null, '')
    ));
  }
  return h('table', { class: 'grid', style: 'margin-bottom:8px' },
    h('tr', null, h('th', null, 'Attachment'), h('th', null, 'Texture'), h('th', null, 'Load'), h('th', null, 'Store'), h('th', null, '')),
    rows);
}

function fmtColor(c: any): string
{
  if (Array.isArray(c)) return `(${c.map(fmtNum).join(', ')})`;
  if (c && typeof c === 'object') return `(${[c.r, c.g, c.b, c.a].map((x) => fmtNum(x ?? 0)).join(', ')})`;
  return String(c);
}

function passDetails(ctx: Ctx, node: TreeNode, el: HTMLElement): void
{
  const pass = node.pass!;
  const desc = pass.begin.a?.[0];
  const draws = countDraws(node);
  el.append(h('div', { class: 'subtitle' }, `${draws.draws} draws, ${draws.dispatches} dispatches · encoder #${pass.encoder.id}`));
  if (pass.json.notes.length) el.append(h('div', { class: 'notes' }, pass.json.notes.map((n) => h('div', { class: 'note' }, `⚠ ${n}`))));

  const last = [...ctx.model.visual].reverse().find((v) => v.pass === pass);
  if (last) el.append(section('Final image', () => outputImages(ctx, last.node, last.snaps, pass.label), { key: 'passfinal' }));
  if (pass.json.kind === 'render') el.append(section('Attachments', () => attachmentsTable(ctx, desc), { key: 'passatt' }));

  const texIds = Object.entries(pass.json.texSnaps);
  if (texIds.length)
  {
    el.append(section(`Sampled textures (${texIds.length})`, () => h('div', { class: 'images' }, texIds.map(([viewId, snap]) =>
    {
      const tex = textureOfView(ctx, { $ref: Number(viewId) });
      return imageBox(ctx, snap, { size: 'small', caption: h('span', null, tex ? refLink(ctx, { $ref: tex.id }, { short: true }) : `view #${viewId}`) });
    })), { key: 'passtex' }));
  }
  el.append(section('Descriptor', () => ptree(ctx, desc), { key: 'passdesc', collapsed: true }));
  const st = stackSection(ctx, pass.begin);
  if (st) el.append(st);
}

function countDraws(node: TreeNode): { draws: number; dispatches: number }
{
  let draws = 0;
  let dispatches = 0;
  const walk = (n: TreeNode) =>
  {
    if (n.isDraw && n.cmd?.n !== 'executeBundles') draws++;
    if (n.isDispatch) dispatches++;
    n.children.forEach(walk);
  };
  walk(node);
  return { draws, dispatches };
}

function groupDetails(ctx: Ctx, node: TreeNode, el: HTMLElement): void
{
  const d = countDraws(node);
  el.append(kv([['Debug group', node.label], ['Draws inside', String(d.draws)], ['Dispatches inside', String(d.dispatches)]]));
  const imgs = ctx.model.visual.filter((v) => isInside(v.node, node));
  const last = imgs[imgs.length - 1];
  if (last) el.append(section('Image after the group', () => outputImages(ctx, last.node, last.snaps, node.label), { key: 'groupimg' }));
}

function isInside(n: TreeNode, ancestor: TreeNode): boolean
{
  for (let p: TreeNode | null = n; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

function bundleDetails(ctx: Ctx, node: TreeNode, el: HTMLElement): void
{
  const b = ctx.obj({ $ref: node.bundle });
  if (node.snap) el.append(section('Output after this bundle', () => outputImages(ctx, node, node.snap, node.label), { key: 'output' }));
  if (b) el.append(kv([['Bundle', refLink(ctx, { $ref: b.id })], ['Draws', String(b.draws)], ['Encoder descriptor', ptree(ctx, b.encoderDesc)]]));
}

function submitDetails(ctx: Ctx, node: TreeNode, el: HTMLElement): void
{
  const d = countDraws(node);
  el.append(kv([['Command buffers', String(node.cmd?.cbs?.length ?? node.children.length)], ['Draws', String(d.draws)], ['Dispatches', String(d.dispatches)]]));
  const st = stackSection(ctx, node.cmd);
  if (st) el.append(st);
}

function commandDetails(ctx: Ctx, node: TreeNode, c: CmdJSON, el: HTMLElement): void
{
  const args = c.a ?? [];
  if (c.n === 'setPipeline')
  {
    const p = ctx.obj(args[0]);
    if (p)
    {
      const stages = pipelineStages(p);
      el.append(section('Pipeline', () => pipelineView(ctx, p, stages), { key: 'pipeline', extra: shaderButtons(ctx, stages) }));
    }
  }
  else if (c.n === 'setBindGroup')
  {
    const pipelineRef = findPipelineBefore(node);
    const stages = pipelineRef ? pipelineStages(ctx.obj(pipelineRef)) : [];
    el.append(section('Bind group', () => bindGroupCard(ctx, node, { index: args[0], bindGroup: args[1], offsets: args[2] ?? [] }, stages), { key: 'bg' }));
  }
  else if (c.n === 'writeBuffer' && c.x?.preview)
  {
    el.append(section('Data written', () =>
    {
      const bytes = Uint8Array.from(atob(c.x.preview), (ch) => ch.charCodeAt(0));
      return h('div', null,
        h('div', { class: 'chip' }, `${c.x.bytes} bytes${c.x.bytes > bytes.length ? ` (first ${bytes.length} shown)` : ''} at offset ${args[1]}`),
        rawViewer({ ranges: [{ offset: args[1] ?? 0, bytes }] }, args[1] ?? 0, bytes.length)
      );
    }, { key: 'wbdata' }));
  }
  if (c.r) el.append(section('Created object', () => h('div', null, refLink(ctx, c.r)), { key: 'created' }));
  el.append(section('Arguments', () => ptree(ctx, args), { key: 'cmdargs' }));
  if (c.o) el.append(kv([['Called on', refLink(ctx, c.o)]]));
  const st = stackSection(ctx, c);
  if (st) el.append(st);
}

function findPipelineBefore(node: TreeNode): any
{
  // Walk backwards through siblings / parents for the most recent setPipeline in this pass.
  let n: TreeNode | null = node;
  while (n && n.kind !== 'pass')
  {
    const parent: TreeNode | null = n.parent;
    if (!parent) break;
    const i = parent.children.indexOf(n);
    for (let k = i; k >= 0; k--)
    {
      const s = parent.children[k];
      if (s.cmd?.n === 'setPipeline') return s.cmd.a?.[0];
      if (s.cmd?.draw?.state?.pipeline) return s.cmd.draw.state.pipeline;
    }
    n = parent;
  }
  return null;
}
