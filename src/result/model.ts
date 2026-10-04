// Turns the flat capture JSON into the tree shown in the command list and the list of
// visual states (one per draw that has an image, plus end-of-pass images).

import type { CaptureJSON, CmdJSON, DrawSnaps, EncoderJSON, PassJSON } from '../shared/protocol';

export type NodeKind = 'root' | 'event' | 'submit' | 'cb' | 'pass' | 'group' | 'cmd' | 'bundle';

export interface PassCtx
{
  index: number;
  json: PassJSON;
  begin: CmdJSON;
  encoder: EncoderJSON;
  label: string;
  node: TreeNode;
}

export interface TreeNode
{
  key: string;
  kind: NodeKind;
  label: string;
  hint?: string;
  cmd?: CmdJSON;
  children: TreeNode[];
  parent: TreeNode | null;
  depth: number;
  pass?: PassCtx;
  encoder?: EncoderJSON;
  drawNo?: number;
  isDraw?: boolean;
  isDispatch?: boolean;
  /** Images after this command (draws) or at pass end. */
  snap?: DrawSnaps;
  /** Draw belongs to a render bundle (state comes from the bundle). */
  bundle?: number;
  /** For the 'end' command of a pass: true when snap is the end-of-pass image. */
  passEnd?: boolean;
  submitNo?: number;
}

export interface VisualState
{
  node: TreeNode;
  pass: PassCtx;
  snaps: DrawSnaps;
  title: string;
  passEnd: boolean;
}

export interface Model
{
  cap: CaptureJSON;
  root: TreeNode;
  flat: TreeNode[];
  byKey: Map<string, TreeNode>;
  passes: PassCtx[];
  visual: VisualState[];
  draws: TreeNode[];
}

const DRAWS = new Set(['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect', 'multiDrawIndirect', 'multiDrawIndexedIndirect']);
const DISPATCHES = new Set(['dispatchWorkgroups', 'dispatchWorkgroupsIndirect']);

export function objLabel(cap: CaptureJSON, ref: any): string
{
  if (!ref || typeof ref !== 'object' || ref.$ref === undefined) return '';
  const o = cap.objects[ref.$ref];
  if (!o) return `#${ref.$ref}`;
  return o.label ? `"${o.label}"` : `#${ref.$ref}`;
}

export function shortType(t: string): string
{
  return t.startsWith('GPU') ? t.slice(3) : t;
}

/** Compact one-line rendering of an argument. */
export function fmtArg(cap: CaptureJSON, v: any, depth = 0): string
{
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
  if (typeof v === 'string') return JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v !== 'object') return String(v);
  if (v.$ref !== undefined)
  {
    const o = cap.objects[v.$ref];
    const t = o ? shortType(o.type) : 'obj';
    return o?.label ? `${t} "${o.label.length > 30 ? `${o.label.slice(0, 30)}…` : o.label}"` : `${t}#${v.$ref}`;
  }
  if (v.$bytes !== undefined) return `${v.$type ?? 'bytes'}(${v.$bytes} B)`;
  if (v.$dom !== undefined) return `${v.$dom}${v.width ? ` ${v.width}×${v.height}` : ''}`;
  if (depth > 1) return Array.isArray(v) ? `[…${v.length}]` : '{…}';
  if (Array.isArray(v))
  {
    if (v.length > 6) return `[${v.slice(0, 6).map((x) => fmtArg(cap, x, depth + 1)).join(', ')}, …]`;
    return `[${v.map((x) => fmtArg(cap, x, depth + 1)).join(', ')}]`;
  }
  const keys = Object.keys(v);
  if (keys.length > 4) return '{…}';
  return `{${keys.map((k) => `${k}: ${fmtArg(cap, v[k], depth + 1)}`).join(', ')}}`;
}

export function cmdLabel(cap: CaptureJSON, c: CmdJSON): string
{
  const args = c.a ?? [];
  if (c.n === 'setBindGroup')
  {
    const offs = args[2] as number[] | undefined;
    return `setBindGroup(${args[0]}, ${fmtArg(cap, args[1])}${offs && offs.length ? `, [${offs.join(', ')}]` : ''})`;
  }
  if (c.n === 'beginRenderPass' || c.n === 'beginComputePass' || c.n.startsWith('create') || c.n === 'configure' || c.n === 'writeTexture' || c.n === 'copyExternalImageToTexture')
  {
    const d = args[0];
    if (d && typeof d === 'object' && typeof d.label === 'string' && d.label) return `${c.n}("${d.label}")`;
    return `${c.n}(${args.length ? '{…}' : ''})`;
  }
  return `${c.n}(${args.map((a) => fmtArg(cap, a)).join(', ')})`;
}

function attachmentSummary(cap: CaptureJSON, begin: CmdJSON): string
{
  const d = begin.a?.[0];
  if (!d) return '';
  const parts: string[] = [];
  for (const a of d.colorAttachments ?? [])
  {
    if (!a) continue;
    const view = cap.objects[a.view?.$ref];
    const tex = view?.type === 'GPUTexture' ? view : cap.objects[view?.texture?.$ref];
    if (tex) parts.push(`${tex.format} ${tex.width}×${tex.height}${tex.sampleCount > 1 ? ` ×${tex.sampleCount}` : ''}${tex.canvasContext ? ' (canvas)' : ''}`);
  }
  const ds = d.depthStencilAttachment;
  if (ds)
  {
    const view = cap.objects[ds.view?.$ref];
    const tex = view?.type === 'GPUTexture' ? view : cap.objects[view?.texture?.$ref];
    if (tex) parts.push(tex.format);
  }
  return parts.join(', ');
}

export function buildModel(cap: CaptureJSON): Model
{
  const root: TreeNode = { key: 'root', kind: 'root', label: 'Frame', children: [], parent: null, depth: -1 };
  const byKey = new Map<string, TreeNode>();
  const passes: PassCtx[] = [];
  const visual: VisualState[] = [];
  const draws: TreeNode[] = [];
  let keySeq = 0;
  let drawNo = 0;
  let submitNo = 0;

  const add = (parent: TreeNode, n: Omit<TreeNode, 'children' | 'parent' | 'depth' | 'key'> & { key?: string }): TreeNode =>
  {
    const node: TreeNode = { ...n, key: n.key ?? `n${keySeq++}`, children: [], parent, depth: parent.depth + 1 };
    parent.children.push(node);
    byKey.set(node.key, node);
    return node;
  };

  const addPass = (parent: TreeNode, c: CmdJSON, enc: EncoderJSON) =>
  {
    const json = c.pass!;
    const d = c.a?.[0];
    const label = typeof d?.label === 'string' && d.label ? d.label : '';
    const kindName = json.kind === 'render' ? 'Render pass' : 'Compute pass';
    const pn = add(parent, {
      kind: 'pass',
      label: `${kindName}${label ? ` "${label}"` : enc.label ? ` (${enc.label})` : ''}`,
      hint: json.kind === 'render' ? attachmentSummary(cap, c) : '',
      cmd: c,
      encoder: enc
    });
    const ctx: PassCtx = { index: passes.length, json, begin: c, encoder: enc, label: pn.label, node: pn };
    pn.pass = ctx;
    passes.push(ctx);

    let cur = pn;
    const stack: TreeNode[] = [];
    for (const pc of json.cmds)
    {
      if (pc.n === 'pushDebugGroup')
      {
        stack.push(cur);
        cur = add(cur, { kind: 'group', label: String(pc.a?.[0] ?? ''), cmd: pc, pass: ctx, encoder: enc });
        continue;
      }
      if (pc.n === 'popDebugGroup')
      {
        cur = stack.pop() ?? pn;
        continue;
      }
      const isDraw = DRAWS.has(pc.n);
      const isDispatch = DISPATCHES.has(pc.n);
      if (pc.n === 'executeBundles')
      {
        const bn = add(cur, { kind: 'cmd', label: cmdLabel(cap, pc), cmd: pc, pass: ctx, encoder: enc, isDraw: true, snap: pc.draw?.snap });
        const bundles: any[] = pc.a?.[0] ?? [];
        bundles.forEach((ref, bi) =>
        {
          const b = cap.objects[ref?.$ref];
          const bnode = add(bn, {
            kind: 'bundle',
            label: `Render bundle${b?.label ? ` "${b.label}"` : ` #${ref?.$ref}`}`,
            hint: b ? `${b.draws} draws` : '',
            pass: ctx,
            encoder: enc,
            bundle: ref?.$ref,
            snap: pc.draw?.bundleSnaps?.[bi] ?? undefined
          });
          for (const bc of b?.cmds ?? [])
          {
            const bd = DRAWS.has(bc.n);
            const n = add(bnode, { kind: 'cmd', label: cmdLabel(cap, bc), cmd: bc, pass: ctx, encoder: enc, isDraw: bd, bundle: ref?.$ref });
            if (bd)
            {
              n.drawNo = ++drawNo;
              draws.push(n);
            }
          }
          if (bnode.snap) visual.push({ node: bnode, pass: ctx, snaps: bnode.snap, title: bnode.label, passEnd: false });
        });
        continue;
      }
      const n = add(cur, {
        kind: 'cmd',
        label: cmdLabel(cap, pc),
        cmd: pc,
        pass: ctx,
        encoder: enc,
        isDraw,
        isDispatch,
        snap: pc.draw?.snap
      });
      if (isDraw || isDispatch)
      {
        n.drawNo = ++drawNo;
        draws.push(n);
        const pl = cap.objects[pc.draw?.state?.pipeline?.$ref ?? -1];
        if (pl?.label) n.hint = pl.label;
      }
      if (pc.n === 'end' && json.endSnap)
      {
        n.snap = json.endSnap;
        n.passEnd = true;
      }
      if (n.snap) visual.push({ node: n, pass: ctx, snaps: n.snap, title: n.passEnd ? 'End of pass' : n.label, passEnd: !!n.passEnd });
    }
  };

  const addEncoder = (parent: TreeNode, enc: EncoderJSON) =>
  {
    let cur = parent;
    const stack: TreeNode[] = [];
    for (const c of enc.cmds)
    {
      if (c.n === 'pushDebugGroup')
      {
        stack.push(cur);
        cur = add(cur, { kind: 'group', label: String(c.a?.[0] ?? ''), cmd: c, encoder: enc });
        continue;
      }
      if (c.n === 'popDebugGroup')
      {
        cur = stack.pop() ?? parent;
        continue;
      }
      if (c.pass)
      {
        addPass(cur, c, enc);
        continue;
      }
      add(cur, { kind: 'cmd', label: cmdLabel(cap, c), cmd: c, encoder: enc, isDraw: false });
    }
  };

  const used = new Set<string>();
  for (const ev of cap.events)
  {
    if (ev.n === 'submit')
    {
      submitNo++;
      const cbs = ev.cbs ?? [];
      const sn = add(root, { kind: 'submit', label: `Submit #${submitNo}`, hint: `${cbs.length} command buffer${cbs.length === 1 ? '' : 's'}`, cmd: ev, submitNo });
      cbs.forEach((id, i) =>
      {
        if (id === null)
        {
          add(sn, { kind: 'cb', label: `Command buffer ${i + 1}`, hint: 'not recorded (encoder created before the capture started)' });
          return;
        }
        const enc = cap.encoders[id];
        if (!enc) return;
        used.add(String(id));
        const cn = add(sn, { kind: 'cb', label: `Command buffer${enc.label ? ` "${enc.label}"` : ` #${id}`}`, encoder: enc });
        addEncoder(cn, enc);
      });
    }
    else
    {
      add(root, { kind: 'event', label: cmdLabel(cap, ev), cmd: ev });
    }
  }
  const unsubmitted = Object.values(cap.encoders).filter((e) => !used.has(String(e.id)));
  if (unsubmitted.length)
  {
    const g = add(root, { kind: 'submit', label: 'Not submitted', hint: `${unsubmitted.length} encoder(s) recorded but not submitted during the capture` });
    for (const enc of unsubmitted)
    {
      const cn = add(g, { kind: 'cb', label: `Command encoder${enc.label ? ` "${enc.label}"` : ` #${enc.id}`}`, encoder: enc });
      addEncoder(cn, enc);
    }
  }

  const flat: TreeNode[] = [];
  const walk = (n: TreeNode) =>
  {
    for (const c of n.children)
    {
      flat.push(c);
      walk(c);
    }
  };
  walk(root);

  return { cap, root, flat, byKey, passes, visual, draws };
}
