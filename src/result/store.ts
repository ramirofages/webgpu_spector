// Where a capture's data comes from: chrome.storage (normal extension use) or memory
// (imported files, and the dev harness that runs outside the extension).

import type { CaptureIndexEntry, CaptureJSON, CaptureResultMessage } from '../shared/protocol';
import { STORAGE_INDEX_KEY } from '../shared/protocol';

export interface CaptureStore
{
  id: string;
  load(): Promise<CaptureJSON>;
  image(snapId: number | string): Promise<string | null>;
  buffer(key: string): Promise<Uint8Array | null>;
  /** All data, for export. */
  exportAll(): Promise<CaptureResultMessage>;
}

export function fromBase64(s: string): Uint8Array
{
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const hasChromeStorage = typeof chrome !== 'undefined' && !!chrome.storage?.local;

export class ChromeStore implements CaptureStore
{
  private pending = new Map<string, ((v: any) => void)[]>();
  private timer: any = 0;
  private imageCache = new Map<string, Promise<string | null>>();

  constructor(public id: string) {}

  async load(): Promise<CaptureJSON>
  {
    const key = `cap:${this.id}`;
    const r = await chrome.storage.local.get(key);
    if (!r[key]) throw new Error('This capture is no longer stored (only the latest captures are kept).');
    return JSON.parse(r[key] as string);
  }

  // Batches the many image requests the visual-state list makes into one storage read.
  private get(key: string): Promise<any>
  {
    return new Promise((resolve) =>
    {
      const list = this.pending.get(key) ?? [];
      list.push(resolve);
      this.pending.set(key, list);
      if (!this.timer)
      {
        this.timer = setTimeout(async () =>
        {
          this.timer = 0;
          const batch = this.pending;
          this.pending = new Map();
          const r = await chrome.storage.local.get([...batch.keys()]);
          for (const [k, cbs] of batch) for (const cb of cbs) cb(r[k] ?? null);
        }, 0);
      }
    });
  }

  image(snapId: number | string): Promise<string | null>
  {
    const key = `cap:${this.id}:i:${snapId}`;
    let p = this.imageCache.get(key);
    if (!p)
    {
      p = this.get(key);
      this.imageCache.set(key, p);
    }
    return p;
  }

  async buffer(key: string): Promise<Uint8Array | null>
  {
    const s = await this.get(`cap:${this.id}:b:${key}`);
    return s ? fromBase64(s) : null;
  }

  async exportAll(): Promise<CaptureResultMessage>
  {
    const r = await chrome.storage.local.get(STORAGE_INDEX_KEY);
    const index = (r[STORAGE_INDEX_KEY] ?? []) as CaptureIndexEntry[];
    const entry = index.find((e) => e.id === this.id);
    const prefix = `cap:${this.id}`;
    const keys = entry?.keys ?? [];
    const all = keys.length ? await chrome.storage.local.get(keys) : await chrome.storage.local.get(null);
    const capture = JSON.parse(all[prefix] as string);
    const images: Record<string, string> = {};
    const buffers: Record<string, string> = {};
    for (const [k, v] of Object.entries(all))
    {
      if (k.startsWith(`${prefix}:i:`)) images[k.slice(prefix.length + 3)] = v as string;
      else if (k.startsWith(`${prefix}:b:`)) buffers[k.slice(prefix.length + 3)] = v as string;
    }
    return { capture, images, buffers };
  }
}

export class MemoryStore implements CaptureStore
{
  constructor(public id: string, private data: CaptureResultMessage) {}

  async load(): Promise<CaptureJSON>
  {
    return this.data.capture;
  }

  async image(snapId: number | string): Promise<string | null>
  {
    return this.data.images[String(snapId)] ?? null;
  }

  async buffer(key: string): Promise<Uint8Array | null>
  {
    const s = this.data.buffers[key];
    return s ? fromBase64(s) : null;
  }

  async exportAll(): Promise<CaptureResultMessage>
  {
    return this.data;
  }
}

export const EXPORT_FORMAT = 'webgpu-spector-capture';

/** Stores an imported capture in chrome.storage and returns its new id. */
export async function importToChrome(data: CaptureResultMessage): Promise<string>
{
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const items: Record<string, string> = { [`cap:${id}`]: JSON.stringify(data.capture) };
  for (const [k, v] of Object.entries(data.images)) items[`cap:${id}:i:${k}`] = v;
  for (const [k, v] of Object.entries(data.buffers)) items[`cap:${id}:b:${k}`] = v;
  await chrome.storage.local.set(items);
  const meta = data.capture.meta;
  const entry: CaptureIndexEntry = {
    id,
    url: meta.url,
    title: `${meta.title || meta.url} (imported)`,
    time: meta.time,
    stats: meta.stats,
    keys: Object.keys(items),
    bytes: Object.values(items).reduce((n, v) => n + v.length, 0)
  };
  await chrome.runtime.sendMessage({ type: 'importCapture', entry });
  return id;
}
