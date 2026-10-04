// Extension simulator: runs the real built popup, background, content script and results page
// in one ordinary tab, wired together with a mocked chrome.* API. Only for testing.
(function ()
{
  const stores = { local: new Map(), session: new Map() };
  const contentListeners = [];
  const extListeners = [];
  const TAB = { id: 1, index: 0, windowId: 1, title: document.title, url: location.href };
  const log = (...a) => console.log('[sim]', ...a);

  function area(map)
  {
    return {
      get(keys)
      {
        const out = {};
        const list = keys == null ? [...map.keys()] : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        for (const k of list) if (map.has(k)) out[k] = structuredClone(map.get(k));
        return Promise.resolve(out);
      },
      set(obj)
      {
        for (const [k, v] of Object.entries(obj)) map.set(k, structuredClone(v));
        return Promise.resolve();
      },
      remove(keys)
      {
        for (const k of [].concat(keys)) map.delete(k);
        return Promise.resolve();
      }
    };
  }

  // Mirrors chrome's messaging: resolves with the first sendResponse, or undefined when no
  // listener keeps the channel open; rejects when nobody listens.
  function dispatch(fns, msg, sender)
  {
    return new Promise((resolve, reject) =>
    {
      if (!fns.length)
      {
        reject(new Error('Could not establish connection. Receiving end does not exist.'));
        return;
      }
      let done = false;
      let async = false;
      const respond = (v) => { if (!done) { done = true; resolve(v); } };
      for (const fn of fns)
      {
        try
        {
          if (fn(structuredClone(msg), sender, respond) === true) async = true;
        }
        catch (e) { console.error(e); }
      }
      if (!async) setTimeout(() => respond(undefined), 0);
    });
  }

  function getURL(p)
  {
    const [file, query] = p.split('?');
    return `/test/ext-sim/page.html?page=${encodeURIComponent(file)}&role=${file.replace(/\.html$/, '')}${query ? `&${query}` : ''}`;
  }

  function openResult(url)
  {
    log('tabs.create', url);
    document.getElementById('result-wrap')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'result-wrap';
    const close = document.createElement('button');
    close.textContent = 'Close result tab';
    close.onclick = () => wrap.remove();
    const f = document.createElement('iframe');
    f.src = url;
    wrap.append(close, f);
    document.body.append(wrap);
  }

  window.__simMakeChrome = function (role)
  {
    return {
      runtime: {
        id: 'sim',
        getURL,
        sendMessage(msg)
        {
          const targets = extListeners.filter((x) => x.role !== role).map((x) => x.fn);
          return dispatch(targets, msg, role === 'content' ? { tab: TAB, frameId: 0 } : {});
        },
        onMessage: {
          addListener(fn)
          {
            if (role === 'content') contentListeners.push(fn);
            else extListeners.push({ role, fn });
          }
        }
      },
      storage: { local: area(stores.local), session: area(stores.session), onChanged: { addListener() {} } },
      tabs: {
        query: async () => [TAB],
        sendMessage: (_tabId, msg) => dispatch(contentListeners, msg, { id: 'sim' }),
        create: async ({ url }) => { openResult(url); return { id: 2 }; },
        reload: () => location.reload(),
        onUpdated: { addListener() {} },
        onRemoved: { addListener() {} }
      },
      action: {
        setBadgeText: async (o) => { document.getElementById('badge').textContent = o.text || '—'; },
        setBadgeBackgroundColor: async () => {}
      }
    };
  };
  window.__simStores = stores;

  window.chrome = window.__simMakeChrome('content');

  addEventListener('DOMContentLoaded', () =>
  {
    const bg = document.createElement('iframe');
    bg.style.display = 'none';
    bg.srcdoc = '<script>window.chrome = parent.__simMakeChrome("background")<\/script><script src="/dist/background.js"><\/script>';
    document.body.append(bg);
    const popup = document.createElement('iframe');
    popup.id = 'popup';
    popup.src = getURL('popup.html');
    document.getElementById('side').append(popup);
  });
})();
