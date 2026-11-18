# WebGPU Spector

A Spector.js-style frame debugger for **WebGPU**, as a Chrome extension. Click the toolbar
icon, press **Capture frame**, and a new tab opens with the captured frame:

- **Visual states**: the render target after every draw call, grouped by render pass, so you
  can watch the frame being composed draw by draw (plus the depth buffer after each draw).
- **Commands**: every submit, command buffer, pass, debug group and call, in order. Draws are
  highlighted and carry their pipeline's label.
- **Draw details**: click any draw to see
  - the output image (and the image before it),
  - draw arguments (indirect args decoded from the captured buffer),
  - the pipeline (stages, entry points, primitive, depth/stencil, blend, MSAA),
  - every bind group: uniform/storage buffers **decoded by field name** from the WGSL
    (via `wgsl_reflect`), textures with a preview *as that pass sampled them*, samplers,
  - vertex buffers (layout and decoded vertices), the index buffer, render pass attachments,
    viewport/scissor, and the JS stack that issued the call.
- **Shader viewer**: WGSL with highlighting, the entry point marked, reflected bindings,
  inputs/outputs and compilation messages.
- **Resources**: every texture, buffer, pipeline, shader, bind group and sampler in the
  frame, each with the images and buffer contents captured for it.
- **Info**: frame stats, including **geometry vertices** (vertices of the geometries drawn,
  summed over draws; indexed draws count the unique vertices their indices reference) and
  **total vertices** (geometry × instance count), plus device, adapter and canvas details.
- **Export / Import**: save a capture to a `.json` file and open it later or send it to someone.

Tested with three.js r183 `WebGPURenderer` (MSAA, log depth, shadows, AgX, half-float output
pass) and hand-written WebGPU (dynamic offsets, compute, indirect draws, occlusion queries,
render bundles).

## Install

```bash
npm install
npm run build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick
the `dist/` folder. For `file://` pages, also enable "Allow access to file URLs" on the
extension's details page.

While developing the extension itself, `npm run watch` rebuilds on save; press the reload
button on the extension card afterwards.

## Use

1. Open a page that renders with WebGPU and click the toolbar icon. The extension is **off on
   every site by default**: press **Enable on <site>**. The page reloads so the hook is in place
   before the page creates its GPU device. The site stays enabled (across browser restarts)
   until you press **Disable on <site>**. A site is a hostname, so enabling `localhost` covers
   every port.
2. The toolbar icon shows a **GPU** badge once a device exists. Press **Capture frame**. The capture starts on the next
   `requestAnimationFrame` (or the next canvas `getCurrentTexture()`), and ends when the next
   frame begins.
3. A results tab opens. Captures are kept in extension storage (the 12 most recent, up to
   1.5 GB), so **Recent captures** in the popup reopens them.

Keyboard in the command list: `↑`/`↓` move, `←`/`→` collapse/expand, `n`/`p` next/previous draw,
`Esc` closes dialogs.

### Capturing from code

To capture exactly when something goes wrong:

```js
window.__WEBGPU_SPECTOR__?.capture();                         // next frame, default options
window.__WEBGPU_SPECTOR__?.capture({ snapshotSize: 2048 });   // override any option
```

### Options (popup → Capture options)

| Option | Default | Notes |
| --- | --- | --- |
| Image after every draw | on | Off = only one image per pass (faster, smaller). |
| Image size | 768 px | Longest side of every stored image. |
| Max draws with images | 1500 | Later draws are still recorded, without images. |
| Depth image after every draw | on | Normalized to the depth range actually used. |
| Previews of sampled textures | on | Taken at the end of the pass that samples them. |
| Buffer contents | on | Buffers ≤ the per-buffer limit are copied whole; bigger ones only their bound ranges. Index buffers use a 64 MB limit (the vertex counts need them). |
| JS stack trace per draw | on | |
| Show float targets sRGB-encoded | on | `rgba16float` targets are usually linear. |
| Lossless images | off | Default is high-quality lossy WebP; lossless keeps exact pixels (~4× bigger). |

## How it works

- Nothing is injected anywhere by default. Enabling a site makes the background worker register
  `hook.js` (page main world) and `content.js` for that hostname with
  `chrome.scripting.registerContentScripts`; disabling unregisters them. The list lives in
  `chrome.storage.local` (`enabledSites`) and the registrations persist across sessions.
- `hook.js` runs in the page's main world at `document_start`, before any page script, and
  patches the WebGPU prototypes. Object creation is always tracked (a WeakMap entry with the
  descriptor), because a capture needs to describe objects created long before it. The patches
  on encoders, passes and queue writes are only installed while a capture is pending or running,
  and the native methods are restored afterwards.
- To read attachments and textures back, it adds `COPY_SRC | TEXTURE_BINDING` to texture and
  canvas usages and `COPY_SRC` to buffers. Transient attachments are left alone.
- **Per-draw images**: during the captured frame, each render pass is split after every draw:
  the pass is ended, the attachments are blitted (downscaled, format-converted) into a small
  texture and copied to a mappable buffer, and the pass is reopened with `loadOp: 'load'` and
  all state re-applied (pipeline, bind groups, buffers, viewport, scissor, blend constant,
  stencil reference, debug groups). Store ops and timestamp writes are moved so the frame
  renders the same. Inside an occlusion query, the split waits until the query ends.
- Buffer contents and sampled textures are copied at the end of each pass, on the page's own
  command encoder, so they are exactly what the GPU used. Unchanged resources are not copied
  twice.
- After the frame, everything is read back, encoded to WebP and handed to the content script,
  which stores it in `chrome.storage.local`. The background worker then opens `result.html`.

## Limitations

- Pages that render from a **Web Worker** (OffscreenCanvas transferred to a worker) can't be
  captured: content scripts don't run in workers.
- WebGPU inside a cross-origin iframe needs that iframe's site enabled too.
- Disabling a site takes full effect when its open pages reload (until then the hook stays in
  the page, idle).
- Only the captured frame is slowed down (by the pass splitting and readback). Between captures,
  draw/pass/encoder calls are native (no wrapper at all); object creation costs about +0.5 µs per
  call (`createBindGroup` 1.0 → 1.5 µs). Measured with `test/bench/` (`?hook=0` vs `?hook=1`):
  10k draws per frame and a 2000-mesh three.js scene showed no measurable difference. On enabled
  sites, the extra usage flags could cost a little GPU-side (e.g. render-target compression on
  some drivers).
- Compute passes aren't split per dispatch: storage buffers and textures show their state at the
  end of the pass.
- 3D textures, stencil and cube faces other than face 0 aren't previewed yet.
- Multisampled targets without a resolve target show sample 0.

## Development

```bash
npm run serve     # http://localhost:5180/test/ : test scenes with the hook loaded directly
```

- `test/scenes/raw.html`: hand-written WebGPU covering most features.
- `test/scenes/three.html`: a three.js `WebGPURenderer` scene.
- `test/bench/index.html?hook=0|1`: CPU overhead of the hook when not capturing.
- `test/ext-sim/`: runs the real popup, content script, background and results page in one tab
  with a mocked `chrome.*`, to test the full flow without installing the extension.
- `node tools/inject-proxy.mjs http://localhost:1234 5190`: proxies any dev server and injects
  the hook plus a floating **Capture** button, for browsers where you can't install the extension.
- `npm run typecheck` runs the TypeScript checker.

Layout: `src/hook` (capture engine), `src/content` (page ↔ extension bridge and storage),
`src/background` (badge, capture index, results tab), `src/popup`, `src/result` (viewer),
`static/` (manifest, HTML, CSS, icons).
