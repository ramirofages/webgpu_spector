// Runs in the page's MAIN world at document_start, before any page script.

import { CONTENT_TAG, HOOK_TAG, type CaptureSettings, type PageStatus } from '../shared/protocol';
import { Recorder } from './capture';
import { captureOriginals } from './gpu';
import { StatusTracker, installPatches } from './patches';

declare global
{
  interface Window
  {
    __WEBGPU_SPECTOR__?: { version: string; capture: (settings?: Partial<CaptureSettings>) => boolean; status: () => PageStatus };
  }
}

const VERSION = '0.1.0';

function post(type: string, payload: unknown, requestId?: string): void
{
  window.postMessage({ __wgs: HOOK_TAG, type, payload, requestId }, '*');
}

function hookScriptUrl(): string
{
  const stack = new Error().stack ?? '';
  const m = stack.match(/((?:chrome-extension|moz-extension|https?|file):\/\/[^\s)]+?\.js)/);
  return m ? m[1] : '';
}

(function main()
{
  if (window.__WEBGPU_SPECTOR__) return;

  const supported = typeof navigator !== 'undefined' && 'gpu' in navigator && typeof GPUDevice !== 'undefined';
  const rec = new Recorder();
  rec.hookUrl = hookScriptUrl();
  const status = new StatusTracker(rec, (s) => post('status', s));

  const snapshot = (): PageStatus => supported
    ? status.snapshot()
    : { webgpu: false, adapters: 0, devices: 0, canvases: [], submits: 0, lastSubmit: null, capturing: false, url: location.href, title: document.title };

  if (supported)
  {
    captureOriginals();
    installPatches(rec, status);
    rec.onProgress = (p) => post('progress', p);
    rec.onResult = (r) => post('result', r);
    rec.onState = () => status.changed();
  }

  window.addEventListener('message', (e) =>
  {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__wgs !== CONTENT_TAG) return;
    switch (d.type)
    {
      case 'capture':
        if (!supported)
        {
          post('progress', { phase: 'error', message: 'WebGPU is not available in this frame.' });
        }
        else if (!rec.request(d.settings))
        {
          post('progress', { phase: 'error', message: 'A capture is already in progress.' });
        }
        break;
      case 'getStatus':
        post('status', snapshot(), d.requestId);
        break;
    }
  });

  Object.defineProperty(window, '__WEBGPU_SPECTOR__', {
    value: Object.freeze({
      version: VERSION,
      /** Capture the next frame from page code, e.g. right when a bug shows up. */
      capture: (settings?: Partial<CaptureSettings>) => supported && rec.request(settings),
      status: snapshot
    }),
    enumerable: false,
    configurable: false,
    writable: false
  });
})();
