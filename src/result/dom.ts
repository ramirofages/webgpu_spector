// Tiny DOM builder. Every string becomes a text node: capture data comes from the inspected
// page and must never be interpreted as HTML in this privileged extension page.

export type Child = Node | string | number | null | undefined | false | Child[];

type Attrs = {
  class?: string;
  style?: string;
  title?: string;
  dataset?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (e: any) => void>>;
  [key: string]: any;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K]
{
  const el = document.createElement(tag);
  if (attrs)
  {
    for (const [k, v] of Object.entries(attrs))
    {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.setAttribute('style', v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'on')
      {
        for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn as EventListener);
      }
      else if (k in el) (el as any)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void
{
  for (const c of children)
  {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void
{
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Collapsible details section. */
export function section(title: Child, body: Child | (() => Child), opts: { collapsed?: boolean; extra?: Child; key?: string } = {}): HTMLElement
{
  const key = opts.key ? `sec:${opts.key}` : '';
  let collapsed = opts.collapsed ?? false;
  if (key)
  {
    try
    {
      const s = localStorage.getItem(key);
      if (s !== null) collapsed = s === '1';
    }
    catch { /* storage unavailable */ }
  }
  const bodyEl = h('div', { class: 'sec-body' });
  let filled = false;
  const fill = () =>
  {
    if (filled) return;
    filled = true;
    append(bodyEl, [typeof body === 'function' ? body() : body]);
  };
  const tw = h('span', { class: 'tw' }, collapsed ? '▶' : '▼');
  const sec = h('section', { class: `sec${collapsed ? ' collapsed' : ''}` },
    h('div', {
      class: 'sec-head',
      on: {
        click: (e: MouseEvent) =>
        {
          if ((e.target as HTMLElement).closest('.extra')) return;
          collapsed = !collapsed;
          sec.classList.toggle('collapsed', collapsed);
          tw.textContent = collapsed ? '▶' : '▼';
          if (!collapsed) fill();
          if (key)
          {
            try
            {
              localStorage.setItem(key, collapsed ? '1' : '0');
            }
            catch { /* ignore */ }
          }
        }
      }
    }, tw, title, opts.extra ? h('span', { class: 'extra' }, opts.extra) : null),
    bodyEl
  );
  if (!collapsed) fill();
  return sec;
}

export function kv(rows: [string, Child][]): HTMLElement
{
  const el = h('div', { class: 'kv' });
  for (const [k, v] of rows)
  {
    if (v === undefined || v === null || v === false || v === '') continue;
    el.append(h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  }
  return el;
}

export function fmtNum(v: number): string
{
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-4 || a >= 1e7)) return v.toExponential(4);
  return String(Number(v.toFixed(5)));
}

export function fmtBytes(n: number): string
{
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T
{
  let t: any = 0;
  return ((...a: any[]) =>
  {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  }) as T;
}
