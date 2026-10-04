// Development harness: stands in for the content script + popup when hook.js is loaded
// directly into a page (test scenes, or tools/inject-proxy.mjs). Adds a floating "Capture"
// button and shows the results page in an overlay iframe.

import { CONTENT_TAG, HOOK_TAG, type CaptureResultMessage, type CaptureSettings } from '../shared/protocol';

declare global
{
  interface Window
  {
    __WGS_DEV__?: {
      capture: (settings?: Partial<CaptureSettings>) => Promise<CaptureResultMessage>;
      last: CaptureResultMessage | null;
      progress: string;
      open: () => void;
    };
  }
}

(function ()
{
  const script = document.currentScript as HTMLScriptElement | null;
  const base = script?.src ? script.src.replace(/devbridge\.js.*$/, '') : '/dist/';
  let waiting: ((r: CaptureResultMessage) => void)[] = [];

  const api: NonNullable<Window['__WGS_DEV__']> = {
    last: null,
    progress: '',
    capture(settings)
    {
      return new Promise((resolve) =>
      {
        waiting.push(resolve);
        window.postMessage({ __wgs: CONTENT_TAG, type: 'capture', settings }, '*');
      });
    },
    open()
    {
      if (api.last) openViewer(api.last);
    }
  };
  window.__WGS_DEV__ = api;

  let label: HTMLSpanElement;

  function ui(): void
  {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483646;display:flex;gap:8px;align-items:center;font:12px system-ui;background:#1c1f26;color:#e3e7ee;padding:6px 8px;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.4)';
    const btn = document.createElement('button');
    btn.textContent = 'Capture frame';
    btn.style.cssText = 'background:#7c4dff;color:#fff;border:0;border-radius:6px;padding:5px 10px;cursor:pointer;font:600 12px system-ui';
    btn.onclick = () =>
    {
      api.capture().then(openViewer);
    };
    label = document.createElement('span');
    label.textContent = 'WebGPU Spector (dev)';
    box.append(btn, label);
    document.body.append(box);
  }

  function openViewer(result: CaptureResultMessage): void
  {
    document.getElementById('__wgs_viewer')?.remove();
    const wrap = document.createElement('div');
    wrap.id = '__wgs_viewer';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#16181d;display:flex;flex-direction:column';
    const close = document.createElement('button');
    close.textContent = 'Close viewer';
    close.style.cssText = 'position:absolute;right:10px;bottom:10px;z-index:2;background:#33295c;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer';
    close.onclick = () => wrap.remove();
    const frame = document.createElement('iframe');
    frame.style.cssText = 'flex:1;border:0;width:100%';
    const onMsg = (e: MessageEvent) =>
    {
      if (e.source === frame.contentWindow && e.data?.type === 'webgpu-spector:ready')
      {
        frame.contentWindow!.postMessage({ type: 'webgpu-spector:capture', result }, '*');
        window.removeEventListener('message', onMsg);
      }
    };
    window.addEventListener('message', onMsg);
    frame.src = `${base}result.html?dev=1`;
    wrap.append(frame, close);
    document.body.append(wrap);
  }

  window.addEventListener('message', (e) =>
  {
    if (e.source !== window || e.data?.__wgs !== HOOK_TAG) return;
    if (e.data.type === 'progress')
    {
      api.progress = e.data.payload.message;
      if (label) label.textContent = e.data.payload.message;
    }
    if (e.data.type === 'result')
    {
      api.last = e.data.payload;
      api.progress = 'done';
      if (label) label.textContent = 'Capture ready';
      const w = waiting;
      waiting = [];
      for (const cb of w) cb(e.data.payload);
    }
  });

  if (document.body) ui();
  else document.addEventListener('DOMContentLoaded', ui);
})();
