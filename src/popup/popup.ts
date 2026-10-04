import {
  DEFAULT_SETTINGS,
  STORAGE_INDEX_KEY,
  STORAGE_SETTINGS_KEY,
  type CaptureIndexEntry,
  type CaptureProgress,
  type CaptureSettings,
  type PageStatus
} from '../shared/protocol';
import { siteLabel } from '../shared/sites';

type FrameStatus = PageStatus & { frameId: number };

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const statusEl = $('#status');
const framesEl = $('#frames');
const captureBtn = $<HTMLButtonElement>('#capture');
const progressEl = $('#progress');
const form = $<HTMLFormElement>('#settings');

let tab: chrome.tabs.Tab | undefined;
let frames: FrameStatus[] = [];
let selectedFrame = 0;
let capturing = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K]
{
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of children) e.append(c);
  return e;
}

// -- settings -------------------------------------------------------------------------

async function loadSettings(): Promise<CaptureSettings>
{
  const r = await chrome.storage.local.get(STORAGE_SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(r[STORAGE_SETTINGS_KEY] ?? {}) };
}

function fillForm(s: CaptureSettings): void
{
  for (const [k, v] of Object.entries(s))
  {
    const input = form.elements.namedItem(k) as HTMLInputElement | HTMLSelectElement | null;
    if (!input) continue;
    if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = !!v;
    else input.value = String(v);
  }
}

function readForm(): CaptureSettings
{
  const s: any = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS))
  {
    const input = form.elements.namedItem(k) as HTMLInputElement | HTMLSelectElement | null;
    if (!input) continue;
    if (input instanceof HTMLInputElement && input.type === 'checkbox') s[k] = input.checked;
    else s[k] = Number(input.value) || (DEFAULT_SETTINGS as any)[k];
  }
  return s;
}

form.addEventListener('change', () =>
{
  chrome.storage.local.set({ [STORAGE_SETTINGS_KEY]: readForm() });
});

$('#reset-settings').addEventListener('click', () =>
{
  fillForm(DEFAULT_SETTINGS);
  chrome.storage.local.set({ [STORAGE_SETTINGS_KEY]: DEFAULT_SETTINGS });
});

// -- site activation & status --------------------------------------------------------

/** undefined = not checked yet, null = a page the extension can't run on. */
let site: string | null | undefined;
let siteEnabled = false;
/** Whether the content script answered in the top frame (false: the page predates enabling). */
let hookLoaded = false;
let justDisabled = false;

async function refreshStatus(): Promise<void>
{
  if (!tab?.id) return;
  const info: { site: string | null; enabled: boolean } | null = await chrome.runtime.sendMessage({ type: 'getSite', url: tab.url }).catch(() => null);
  site = info?.site ?? null;
  siteEnabled = !!info?.enabled;
  if (!site || !siteEnabled)
  {
    frames = [];
    hookLoaded = false;
    render();
    return;
  }

  // Frames that reported WebGPU use to the background, plus the top frame asked directly (so a
  // lost status message never hides a page that is rendering).
  const stored: Record<string, FrameStatus> = await chrome.runtime.sendMessage({ type: 'getTabStatus', tabId: tab.id }).catch(() => ({}));
  const frameIds = new Set<number>([0, ...Object.values(stored ?? {}).map((f) => f.frameId)]);
  const list: FrameStatus[] = [];
  hookLoaded = false;
  for (const frameId of frameIds)
  {
    const reply = await chrome.tabs.sendMessage(tab.id, { type: 'getStatus' }, { frameId }).then(
      (v: PageStatus | null) => ({ ok: true, v }),
      () => ({ ok: false, v: null as PageStatus | null })
    );
    if (frameId === 0 && reply.ok) hookLoaded = true;
    const known = Object.values(stored ?? {}).find((f) => f.frameId === frameId);
    if (reply.v || known) list.push({ ...(reply.v ?? known!), frameId });
  }
  frames = list.filter((f) => f.webgpu && (f.devices > 0 || f.adapters > 0));
  render();
}

function reloadButton(): HTMLButtonElement
{
  const reload = el('button', { className: 'secondary', textContent: 'Reload page' });
  reload.addEventListener('click', () =>
  {
    if (tab?.id) chrome.tabs.reload(tab.id);
    window.close();
  });
  return reload;
}

const enableBtn = $<HTMLButtonElement>('#enable');
const disableBtn = $<HTMLButtonElement>('#disable');

async function setSite(enabled: boolean): Promise<void>
{
  if (!site || !tab?.id) return;
  enableBtn.disabled = true;
  disableBtn.disabled = true;
  const r = await chrome.runtime.sendMessage({ type: 'setSite', site, enabled }).catch((e) => ({ ok: false, error: String(e) }));
  enableBtn.disabled = false;
  disableBtn.disabled = false;
  if (!r?.ok)
  {
    showProgress({ phase: 'error', message: `Could not change the site setting: ${r?.error ?? 'unknown error'}` });
    return;
  }
  if (enabled)
  {
    // The hook has to be in place before the page creates its GPU device.
    chrome.tabs.reload(tab.id);
    window.close();
    return;
  }
  justDisabled = true;
  await refreshStatus();
}

enableBtn.addEventListener('click', () => setSite(true));
disableBtn.addEventListener('click', () => setSite(false));

function render(): void
{
  statusEl.replaceChildren();
  const title = frames.find((f) => f.frameId === 0)?.title || tab?.title || '';
  $('#tab-title').textContent = title || tab?.url || '';
  const label = site ? siteLabel(site) : '';

  enableBtn.hidden = !site || siteEnabled;
  disableBtn.hidden = !site || !siteEnabled;
  captureBtn.hidden = !site || !siteEnabled;
  enableBtn.textContent = `Enable on ${label}`;
  disableBtn.textContent = `Disable on ${label}`;
  framesEl.hidden = true;

  if (site === undefined)
  {
    statusEl.append(el('p', { className: 'muted' }, 'Checking this page…'));
    return;
  }
  if (site === null)
  {
    statusEl.append(el('p', {}, el('span', { className: 'dot off' }), 'WebGPU Spector can’t run on this page.'));
    return;
  }
  if (!siteEnabled)
  {
    statusEl.append(el('p', {}, el('span', { className: 'dot off' }), `Off for ${label}.`));
    if (justDisabled)
    {
      statusEl.append(el('p', { className: 'muted' }, 'The open page keeps the hook until it reloads.'), reloadButton());
    }
    else
    {
      statusEl.append(el('p', { className: 'muted' }, 'Nothing is injected into this site until you enable it. Enabling reloads the page, so the hook is in place before it creates its GPU device. It stays enabled until you disable it.'));
    }
    return;
  }
  if (!hookLoaded)
  {
    statusEl.append(
      el('p', {}, el('span', { className: 'dot off' }), `On for ${label}. Reload the page to start.`),
      el('p', { className: 'muted' }, 'This page was opened before the hook was enabled (or before the extension was reloaded).'),
      reloadButton()
    );
    captureBtn.disabled = true;
    return;
  }
  if (!frames.length)
  {
    statusEl.append(
      el('p', {}, el('span', { className: 'dot off' }), `On for ${label}. No WebGPU device yet.`),
      el('p', { className: 'muted' }, 'The capture button unlocks once the page creates a GPU device. If WebGPU only runs inside a cross-origin iframe, enable that iframe’s site too.')
    );
    captureBtn.disabled = true;
    return;
  }

  if (!frames.some((f) => f.frameId === selectedFrame))
  {
    selectedFrame = [...frames].sort((a, b) => b.submits - a.submits)[0].frameId;
  }

  const f = frames.find((x) => x.frameId === selectedFrame)!;
  const active = f.lastSubmit !== null && Date.now() - f.lastSubmit < 2000;
  statusEl.append(el('p', {},
    el('span', { className: `dot ${active ? 'ok' : 'off'}` }),
    `${f.devices} GPU device${f.devices === 1 ? '' : 's'}, ${active ? 'rendering' : 'idle'}`
  ));
  if (f.canvases.length)
  {
    const ul = el('ul', { className: 'canvas-list' });
    for (const c of f.canvases) ul.append(el('li', {}, `${c.id}  ${c.width}×${c.height}  ${c.format}`));
    statusEl.append(ul);
  }
  else
  {
    statusEl.append(el('p', { className: 'muted' }, 'No configured canvas (offscreen rendering).'));
  }
  if (!active)
  {
    statusEl.append(el('p', { className: 'muted' }, 'No queue.submit() in the last 2 s: the capture starts on the next frame the page renders.'));
  }

  framesEl.replaceChildren();
  framesEl.hidden = frames.length < 2;
  if (frames.length > 1)
  {
    for (const fr of frames)
    {
      const radio = el('input', { type: 'radio', name: 'frame', checked: fr.frameId === selectedFrame });
      radio.addEventListener('change', () =>
      {
        selectedFrame = fr.frameId;
        render();
      });
      framesEl.append(el('label', { title: fr.url }, radio, fr.frameId === 0 ? 'Top frame' : `iframe: ${fr.url}`));
    }
  }
  captureBtn.disabled = capturing || f.capturing;
}

// -- capture ---------------------------------------------------------------------------

function showProgress(p: CaptureProgress): void
{
  progressEl.hidden = false;
  progressEl.classList.toggle('error', p.phase === 'error');
  const bar = progressEl.querySelector('.bar') as HTMLElement;
  const fill = bar.firstElementChild as HTMLElement;
  if (p.total)
  {
    bar.classList.remove('indeterminate');
    fill.style.width = `${Math.round(((p.done ?? 0) / p.total) * 100)}%`;
  }
  else
  {
    bar.classList.toggle('indeterminate', p.phase !== 'done' && p.phase !== 'error');
    fill.style.width = p.phase === 'done' ? '100%' : '30%';
  }
  progressEl.querySelector('.msg')!.textContent = p.message;
  if (p.phase === 'done' || p.phase === 'error')
  {
    capturing = false;
    captureBtn.disabled = false;
  }
}

captureBtn.addEventListener('click', async () =>
{
  if (!tab?.id) return;
  capturing = true;
  captureBtn.disabled = true;
  showProgress({ phase: 'waiting', message: 'Waiting for the next frame…' });
  const settings = readForm();
  await chrome.storage.local.set({ [STORAGE_SETTINGS_KEY]: settings });
  try
  {
    await chrome.tabs.sendMessage(tab.id, { type: 'capture', settings }, { frameId: selectedFrame });
  }
  catch
  {
    showProgress({ phase: 'error', message: 'Could not reach the page. Reload it and try again.' });
  }
});

chrome.runtime.onMessage.addListener((msg, sender) =>
{
  if (msg?.type === 'progress' && sender.tab?.id === tab?.id) showProgress(msg.progress);
  if (msg?.type === 'status' && sender.tab?.id === tab?.id) refreshStatus();
});

// -- recent captures ---------------------------------------------------------------------

function timeAgo(t: number): string
{
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

async function renderRecent(): Promise<void>
{
  const r = await chrome.storage.local.get(STORAGE_INDEX_KEY);
  const index = (r[STORAGE_INDEX_KEY] ?? []) as CaptureIndexEntry[];
  const ul = $('#recent ul');
  ul.replaceChildren();
  if (!index.length)
  {
    ul.append(el('li', { className: 'empty' }, 'Nothing captured yet.'));
    return;
  }
  for (const e of index)
  {
    let host = e.url;
    try
    {
      host = new URL(e.url).host || e.url;
    }
    catch { /* keep */ }
    const del = el('button', { title: 'Delete capture', textContent: '✕' });
    const li = el('li', { title: e.url },
      el('div', { className: 'info' },
        el('div', { className: 'title' }, e.title || host),
        el('div', { className: 'sub' }, `${host} · ${e.stats.draws ?? 0} draws · ${timeAgo(e.time)} · ${(e.bytes / 1048576).toFixed(1)} MB`)
      ),
      del
    );
    li.addEventListener('click', () =>
    {
      chrome.runtime.sendMessage({ type: 'openCapture', id: e.id });
      window.close();
    });
    del.addEventListener('click', async (ev) =>
    {
      ev.stopPropagation();
      await chrome.runtime.sendMessage({ type: 'deleteCapture', id: e.id });
      renderRecent();
    });
    ul.append(li);
  }
}

// -- init ----------------------------------------------------------------------------------

(async () =>
{
  fillForm(await loadSettings());
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  render();
  await refreshStatus();
  await renderRecent();
  chrome.storage.onChanged?.addListener((changes, area) =>
  {
    if (area === 'local' && changes[STORAGE_INDEX_KEY]) renderRecent();
  });
  setInterval(refreshStatus, 1500);
})();
