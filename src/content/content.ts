// Isolated-world bridge: relays between the hook (page MAIN world, via window.postMessage)
// and the extension (popup / background), and stores finished captures in chrome.storage.

import {
  CONTENT_TAG,
  HOOK_TAG,
  type CaptureIndexEntry,
  type CaptureResultMessage,
  type PageStatus
} from '../shared/protocol';

let lastStatus: PageStatus | null = null;
const pendingStatus = new Map<string, (s: PageStatus | null) => void>();

function extensionAlive(): boolean
{
  try
  {
    return !!chrome.runtime?.id;
  }
  catch
  {
    return false;
  }
}

function send(msg: unknown): void
{
  if (!extensionAlive()) return;
  chrome.runtime.sendMessage(msg).catch(() => { /* popup closed: fine */ });
}

function toHook(msg: Record<string, unknown>): void
{
  window.postMessage({ __wgs: CONTENT_TAG, ...msg }, '*');
}

window.addEventListener('message', (e) =>
{
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.__wgs !== HOOK_TAG) return;
  switch (d.type)
  {
    case 'status':
    {
      lastStatus = d.payload;
      const cb = d.requestId && pendingStatus.get(d.requestId);
      if (cb)
      {
        pendingStatus.delete(d.requestId);
        cb(lastStatus);
      }
      if (lastStatus?.webgpu) send({ type: 'status', status: lastStatus });
      break;
    }
    case 'progress':
      send({ type: 'progress', progress: d.payload });
      break;
    case 'result':
      storeCapture(d.payload).catch((err) =>
      {
        console.error('[WebGPU Spector] could not store the capture', err);
        send({ type: 'progress', progress: { phase: 'error', message: `Could not store the capture: ${err?.message ?? err}` } });
      });
      break;
  }
});

if (extensionAlive())
{
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) =>
  {
    if (msg?.type === 'capture')
    {
      toHook({ type: 'capture', settings: msg.settings });
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'getStatus')
    {
      const requestId = Math.random().toString(36).slice(2);
      pendingStatus.set(requestId, sendResponse);
      toHook({ type: 'getStatus', requestId });
      setTimeout(() =>
      {
        if (pendingStatus.has(requestId))
        {
          pendingStatus.delete(requestId);
          sendResponse(lastStatus);
        }
      }, 400);
      return true;
    }
    return false;
  });
}

async function storeCapture(result: CaptureResultMessage): Promise<void>
{
  if (!extensionAlive()) throw new Error('the extension was reloaded; reload this page');
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const items: [string, string][] = [[`cap:${id}`, JSON.stringify(result.capture)]];
  for (const [k, v] of Object.entries(result.images)) items.push([`cap:${id}:i:${k}`, v]);
  for (const [k, v] of Object.entries(result.buffers)) items.push([`cap:${id}:b:${k}`, v]);

  let bytes = 0;
  let batch: Record<string, string> = {};
  let batchBytes = 0;
  let written = 0;
  for (const [k, v] of items)
  {
    batch[k] = v;
    batchBytes += v.length;
    bytes += v.length;
    if (batchBytes > 8_000_000)
    {
      await chrome.storage.local.set(batch);
      written += Object.keys(batch).length;
      send({ type: 'progress', progress: { phase: 'saving', message: `Saving capture… ${Math.round((written / items.length) * 100)}%` } });
      batch = {};
      batchBytes = 0;
    }
  }
  if (Object.keys(batch).length) await chrome.storage.local.set(batch);

  const meta = result.capture.meta;
  const entry: CaptureIndexEntry = {
    id,
    url: meta.url,
    title: meta.title,
    time: meta.time,
    stats: meta.stats,
    keys: items.map(([k]) => k),
    bytes
  };
  send({ type: 'captureStored', entry });
  send({ type: 'progress', progress: { phase: 'done', message: 'Capture ready, opening it in a new tab.' } });
}
