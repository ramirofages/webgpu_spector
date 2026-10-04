// Service worker: injects the hook only on the sites the user enabled, remembers which
// tabs/frames use WebGPU (for the popup and the badge), keeps the capture index, and opens the
// results tab.

import { MAX_STORED_BYTES, MAX_STORED_CAPTURES, STORAGE_INDEX_KEY, type CaptureIndexEntry, type PageStatus } from '../shared/protocol';
import { SITES_KEY, siteOf, sitePatterns } from '../shared/sites';

// -- per-site activation -----------------------------------------------------------

const SCRIPT_IDS = ['wgs-hook', 'wgs-content'];

async function getSites(): Promise<string[]>
{
  const r = await chrome.storage.local.get(SITES_KEY);
  return (r[SITES_KEY] as string[]) ?? [];
}

let registrationChain: Promise<unknown> = Promise.resolve();

/** Registers hook.js + content.js for exactly the enabled sites (nothing when none are). */
function syncRegistrations(): Promise<void>
{
  const next = registrationChain.then(async () =>
  {
    const sites = await getSites();
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
    if (!sites.length) return;
    const matches = sites.flatMap(sitePatterns);
    await chrome.scripting.registerContentScripts([
      // The hook must run in the page's world before any page script creates a GPU device.
      { id: 'wgs-hook', js: ['hook.js'], matches, runAt: 'document_start', allFrames: true, matchOriginAsFallback: true, world: 'MAIN', persistAcrossSessions: true },
      { id: 'wgs-content', js: ['content.js'], matches, runAt: 'document_start', allFrames: true, matchOriginAsFallback: true, persistAcrossSessions: true }
    ]);
  });
  registrationChain = next.catch((e) => console.error('[WebGPU Spector] could not register content scripts', e));
  return next;
}

async function setSiteEnabled(site: string, enabled: boolean): Promise<void>
{
  const sites = (await getSites()).filter((s) => s !== site);
  if (enabled) sites.push(site);
  await chrome.storage.local.set({ [SITES_KEY]: sites.sort() });
  await syncRegistrations();
}

// Registrations persist across browser sessions, but are re-applied after installs/updates.
chrome.runtime.onInstalled.addListener(() => { syncRegistrations(); });
chrome.runtime.onStartup.addListener(() => { syncRegistrations(); });

// -- tab status --------------------------------------------------------------------

type FrameStatuses = Record<string, PageStatus & { frameId: number; updated: number }>;

const tabKey = (tabId: number) => `tab:${tabId}`;

async function getFrames(tabId: number): Promise<FrameStatuses>
{
  const key = tabKey(tabId);
  const r = await chrome.storage.session.get(key);
  return (r[key] as FrameStatuses) ?? {};
}

async function setFrameStatus(tabId: number, frameId: number, status: PageStatus): Promise<void>
{
  const frames = await getFrames(tabId);
  frames[frameId] = { ...status, frameId, updated: Date.now() };
  await chrome.storage.session.set({ [tabKey(tabId)]: frames });
  const devices = Object.values(frames).reduce((n, f) => n + f.devices, 0);
  await chrome.action.setBadgeText({ tabId, text: devices > 0 ? 'GPU' : '' });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c4dff' });
}

async function clearTab(tabId: number): Promise<void>
{
  await chrome.storage.session.remove(tabKey(tabId));
}

// Serialize index updates so concurrent captures don't clobber each other.
let indexChain: Promise<unknown> = Promise.resolve();

function updateIndex(fn: (index: CaptureIndexEntry[]) => Promise<CaptureIndexEntry[]> | CaptureIndexEntry[]): Promise<void>
{
  const next = indexChain.then(async () =>
  {
    const r = await chrome.storage.local.get(STORAGE_INDEX_KEY);
    const index = (r[STORAGE_INDEX_KEY] as CaptureIndexEntry[]) ?? [];
    const updated = await fn(index);
    await chrome.storage.local.set({ [STORAGE_INDEX_KEY]: updated });
  });
  indexChain = next.catch(() => {});
  return next;
}

function openResult(id: string, tab?: chrome.tabs.Tab): Promise<chrome.tabs.Tab>
{
  const url = chrome.runtime.getURL(`result.html?id=${encodeURIComponent(id)}`);
  return chrome.tabs.create({
    url,
    index: tab ? tab.index + 1 : undefined,
    openerTabId: tab?.id,
    windowId: tab?.windowId
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) =>
{
  switch (msg?.type)
  {
    case 'status':
      if (sender.tab?.id !== undefined) setFrameStatus(sender.tab.id, sender.frameId ?? 0, msg.status).catch(() => {});
      return false;

    case 'getTabStatus':
      getFrames(msg.tabId).then(sendResponse, () => sendResponse({}));
      return true;

    case 'getSite':
    {
      const site = siteOf(msg.url);
      getSites().then((sites) => sendResponse({ site, enabled: !!site && sites.includes(site) }), () => sendResponse({ site, enabled: false }));
      return true;
    }

    case 'setSite':
      setSiteEnabled(msg.site, !!msg.enabled).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
      return true;

    case 'captureStored':
    {
      const entry = msg.entry as CaptureIndexEntry;
      updateIndex(async (index) =>
      {
        index.unshift(entry);
        // Keep the newest captures within both a count and a total size budget.
        let total = 0;
        let keep = 0;
        for (const e of index)
        {
          if (keep >= MAX_STORED_CAPTURES || (keep > 0 && total + e.bytes > MAX_STORED_BYTES)) break;
          total += e.bytes;
          keep++;
        }
        const removed = index.splice(keep);
        for (const old of removed) await chrome.storage.local.remove(old.keys);
        return index;
      }).then(() => openResult(entry.id, sender.tab)).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case 'openCapture':
      openResult(msg.id).then(() => sendResponse({ ok: true }));
      return true;

    case 'deleteCapture':
      updateIndex(async (index) =>
      {
        const i = index.findIndex((e) => e.id === msg.id);
        if (i >= 0)
        {
          await chrome.storage.local.remove(index[i].keys);
          index.splice(i, 1);
        }
        return index;
      }).then(() => sendResponse({ ok: true }));
      return true;

    case 'importCapture':
    {
      // Sent by the results page after it stored an imported file's items.
      const entry = msg.entry as CaptureIndexEntry;
      updateIndex((index) =>
      {
        index.unshift(entry);
        return index;
      }).then(() => sendResponse({ ok: true }));
      return true;
    }
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, info) =>
{
  if (info.status === 'loading') clearTab(tabId).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) =>
{
  clearTab(tabId).catch(() => {});
});
