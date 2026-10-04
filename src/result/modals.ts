// Shader source viewer and zoomable image viewer.

import type { Ctx, ShaderStageRef } from './ctx';
import { reflectModule } from './decode';
import { append, clear, h } from './dom';
import { highlightLines } from './wgsl';
import { snapCaption } from './widgets';

function modal(title: string, headExtra: Node[], body: HTMLElement, onClose?: () => void): () => void
{
  const close = () =>
  {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e: KeyboardEvent) =>
  {
    if (e.key === 'Escape')
    {
      e.stopPropagation();
      close();
    }
  };
  const back = h('div', { class: 'modal-back', on: { mousedown: (e: MouseEvent) => { if (e.target === back) close(); } } },
    h('div', { class: 'modal' },
      h('div', { class: 'm-head' }, h('h3', null, title), ...headExtra, h('button', { class: 'btn', on: { click: close } }, 'Close')),
      h('div', { class: 'm-body' }, body)
    )
  );
  document.body.append(back);
  document.addEventListener('keydown', onKey, true);
  return close;
}

// ---------------------------------------------------------------------------

export function codeView(code: string, opts: { highlightLines?: [number, number]; messages?: any[] } = {}): HTMLElement
{
  const pre = h('div', { class: 'code' });
  const lines = highlightLines(code);
  const msgByLine = new Map<number, any>();
  for (const m of opts.messages ?? []) if (m.lineNum) msgByLine.set(m.lineNum, m);
  lines.forEach((nodes, i) =>
  {
    const ln = i + 1;
    const span = h('span', { class: 'src' });
    span.append(...nodes);
    if (!nodes.length) span.append(' ');
    const row = h('div', { class: 'ln', dataset: { line: String(ln) } }, span);
    if (opts.highlightLines && ln >= opts.highlightLines[0] && ln <= opts.highlightLines[1]) row.classList.add('hl');
    const m = msgByLine.get(ln);
    if (m)
    {
      row.classList.add(`msg-${m.type}`);
      row.title = m.message;
    }
    pre.append(row);
  });
  return pre;
}

function scrollToLine(pre: HTMLElement, line: number): void
{
  const row = pre.querySelector(`[data-line="${line}"]`) as HTMLElement | null;
  if (row) pre.scrollTop = Math.max(0, row.offsetTop - 80);
}

export function openShaderModal(ctx: Ctx, stages: ShaderStageRef[], focus = 0, highlight?: { group: number; binding: number }): void
{
  let current = Math.min(focus, stages.length - 1);
  const main = h('div', { class: 'shader-main' });
  const side = h('div', { class: 'shader-side' });
  const tabs = h('div', { class: 'm-tabs' });
  const copyBtn = h('button', { class: 'btn' }, 'Copy');
  const body = h('div', { style: 'display:flex;flex:1;min-width:0' }, main, side);

  const render = () =>
  {
    for (const [i, b] of [...tabs.children].entries()) b.classList.toggle('on', i === current);
    const s = stages[current];
    const mod = ctx.cap.objects[s.module];
    clear(main);
    clear(side);
    if (!mod)
    {
      main.append(h('div', { class: 'empty-state' }, 'Module not in capture.'));
      return;
    }
    const code: string = mod.code ?? '';
    const r = reflectModule(ctx.cap, s.module);
    const fn = s.entryPoint ? r?.getFunctionInfo(s.entryPoint) : r?.entry[s.stage as 'vertex' | 'fragment' | 'compute']?.[0];
    const range: [number, number] | undefined = fn ? [fn.startLine, fn.endLine] : undefined;
    const pre = codeView(code, { highlightLines: range, messages: mod.messages });
    main.append(pre);

    append(side, [h('h4', null, 'Module'),
      h('div', { class: 'mono', style: 'margin-bottom:8px' }, mod.label ? `"${mod.label}" ` : '', `#${mod.id}`, ` · ${code.split('\n').length} lines`),
      s.entryPoint || fn ? h('div', { class: 'res', on: { click: () => range && scrollToLine(pre, range[0]) } }, `entry: ${fn?.name ?? s.entryPoint}`) : null
    ]);
    if (mod.messages?.length)
    {
      side.append(h('h4', { style: 'margin-top:12px' }, 'Compilation messages'),
        h('div', { class: 'msgs' }, mod.messages.map((m: any) =>
          h('div', { class: `m ${m.type}`, on: { click: () => scrollToLine(pre, m.lineNum) } }, `${m.lineNum}:${m.linePos} ${m.type}: ${m.message}`))));
    }
    if (r)
    {
      const groups = r.getBindGroups();
      const used = new Set((fn?.resources ?? []).map((v: any) => `${v.group}:${v.binding}`));
      side.append(h('h4', { style: 'margin-top:12px' }, 'Bindings'));
      groups.forEach((g: any[], gi: number) => (g ?? []).forEach((v: any, bi: number) =>
      {
        if (!v) return;
        const decl = findDeclLine(code, v.name);
        const isHl = highlight && highlight.group === gi && highlight.binding === bi;
        side.append(h('div', {
          class: 'res',
          style: `${used.size && !used.has(`${gi}:${bi}`) ? 'opacity:.5;' : ''}${isHl ? 'color:var(--accent);' : ''}`,
          title: used.size && !used.has(`${gi}:${bi}`) ? 'not used by this entry point' : '',
          on: { click: () => decl && scrollToLine(pre, decl) }
        }, `@group(${gi}) @binding(${bi}) ${v.name}: ${v.type?.getTypeName ? v.type.getTypeName() : v.type?.name ?? ''}`));
      }));
      if (fn?.inputs?.length)
      {
        side.append(h('h4', { style: 'margin-top:12px' }, 'Inputs'));
        for (const inp of fn.inputs) side.append(h('div', { class: 'res', style: 'cursor:default' }, `${inp.locationType === 'builtin' ? `@builtin(${inp.location})` : `@location(${inp.location})`} ${inp.name}: ${inp.type?.getTypeName ? inp.type.getTypeName() : inp.type?.name ?? ''}`));
      }
      if (fn?.outputs?.length)
      {
        side.append(h('h4', { style: 'margin-top:12px' }, 'Outputs'));
        for (const o of fn.outputs) side.append(h('div', { class: 'res', style: 'cursor:default' }, `${o.locationType === 'builtin' ? `@builtin(${o.location})` : `@location(${o.location})`} ${o.name}: ${o.type?.getTypeName ? o.type.getTypeName() : o.type?.name ?? ''}`));
      }
    }
    else
    {
      side.append(h('div', { class: 'note', style: 'margin-top:12px' }, 'Reflection unavailable (the parser could not read this module).'));
    }
    requestAnimationFrame(() =>
    {
      if (highlight && r)
      {
        const v = r.findResource(highlight.group, highlight.binding);
        const decl = v ? findDeclLine(code, v.name) : 0;
        if (decl) return scrollToLine(pre, decl);
      }
      if (range) scrollToLine(pre, range[0]);
    });
    copyBtn.onclick = () => navigator.clipboard.writeText(code);
  };

  stages.forEach((s, i) => tabs.append(h('button', { on: { click: () => { current = i; render(); } } }, `${s.stage}${stages.filter((x) => x.module === s.module).length > 1 ? '' : ` #${s.module}`}`)));
  const title = stages.length > 1 && stages.every((s) => s.module === stages[0].module) ? 'Shader module' : 'Shaders';
  modal(title, [tabs, copyBtn], body);
  render();
}

function findDeclLine(code: string, name: string): number
{
  const re = new RegExp(`\\bvar(<[^>]*>)?\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return 0;
}

// ---------------------------------------------------------------------------

export function openImageModal(ctx: Ctx, snapId: number, title?: string): void
{
  const meta = ctx.cap.snapshots[snapId];
  const stage = h('div', { class: 'iv-stage' });
  const img = h('img', { alt: '' });
  stage.append(img);
  const info = h('div', { class: 'iv-info' });
  const pix = h('span');
  const zoomLbl = h('span');
  info.append(h('span', null, meta ? snapCaption(meta) : ''), zoomLbl, pix);
  const body = h('div', { style: 'flex:1;display:flex;flex-direction:column;min-width:0' }, stage);

  let scale = 1;
  let tx = 0;
  let ty = 0;
  const canvas = document.createElement('canvas');
  let ctx2d: CanvasRenderingContext2D | null = null;

  const apply = () =>
  {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    zoomLbl.textContent = `${Math.round(scale * 100 * (meta ? meta.width / meta.srcWidth : 1))}%`;
  };
  const fit = () =>
  {
    const r = stage.getBoundingClientRect();
    const w = img.naturalWidth || 1;
    const hh = img.naturalHeight || 1;
    scale = Math.min(r.width / w, r.height / hh) * 0.96;
    tx = (r.width - w * scale) / 2;
    ty = (r.height - hh * scale) / 2;
    apply();
  };

  img.addEventListener('load', () =>
  {
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx2d = canvas.getContext('2d', { willReadFrequently: true });
    ctx2d?.drawImage(img, 0, 0);
    fit();
  });
  ctx.store.image(snapId).then((url) =>
  {
    if (url && url.startsWith('data:image/')) img.src = url;
  });

  stage.addEventListener('wheel', (e) =>
  {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const k = Math.exp(-e.deltaY * 0.0015);
    const ns = Math.min(64, Math.max(0.05, scale * k));
    tx = mx - ((mx - tx) * ns) / scale;
    ty = my - ((my - ty) * ns) / scale;
    scale = ns;
    apply();
  }, { passive: false });

  let drag: { x: number; y: number; tx: number; ty: number } | null = null;
  stage.addEventListener('mousedown', (e) =>
  {
    drag = { x: e.clientX, y: e.clientY, tx, ty };
    stage.classList.add('panning');
  });
  window.addEventListener('mouseup', () =>
  {
    drag = null;
    stage.classList.remove('panning');
  });
  stage.addEventListener('mousemove', (e) =>
  {
    if (drag)
    {
      tx = drag.tx + e.clientX - drag.x;
      ty = drag.ty + e.clientY - drag.y;
      apply();
    }
    const r = stage.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left - tx) / scale);
    const y = Math.floor((e.clientY - r.top - ty) / scale);
    if (!ctx2d || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height)
    {
      pix.textContent = '';
      return;
    }
    const d = ctx2d.getImageData(x, y, 1, 1).data;
    const sx = meta ? Math.floor((x + 0.5) * (meta.srcWidth / meta.width)) : x;
    const sy = meta ? Math.floor((y + 0.5) * (meta.srcHeight / meta.height)) : y;
    clear(pix);
    pix.append(
      h('span', { class: 'sw', style: `background: rgb(${d[0]}, ${d[1]}, ${d[2]})` }),
      ` texel ≈ (${sx}, ${sy})  rgb ${d[0]} ${d[1]} ${d[2]}  ·  ${(d[0] / 255).toFixed(3)} ${(d[1] / 255).toFixed(3)} ${(d[2] / 255).toFixed(3)}`
    );
  });

  const fitBtn = h('button', { class: 'btn', on: { click: fit } }, 'Fit');
  const oneBtn = h('button', {
    class: 'btn',
    on: {
      click: () =>
      {
        scale = meta ? meta.srcWidth / meta.width : 1;
        apply();
      }
    }
  }, '1:1');
  const save = h('button', {
    class: 'btn',
    on: {
      click: () =>
      {
        canvas.toBlob((blob) =>
        {
          if (!blob) return;
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `snapshot-${snapId}.png`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        }, 'image/png');
      }
    }
  }, 'Save PNG');
  if (meta && meta.width < meta.srcWidth)
  {
    info.append(h('span', { class: 'chip', title: 'Raise "Image size" in the popup options for full resolution' }, `stored at ${meta.width}×${meta.height}`));
  }
  modal(title ?? 'Image', [info, fitBtn, oneBtn, save], body);
}
