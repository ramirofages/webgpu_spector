import { HANDLE_TYPES, idOf, tagOf } from './registry';

const DOM_SOURCES = new Set([
  'HTMLCanvasElement', 'HTMLImageElement', 'HTMLVideoElement', 'ImageBitmap', 'OffscreenCanvas',
  'VideoFrame', 'ImageData', 'SVGImageElement'
]);

function domSummary(v: any, tag: string): any
{
  const width = v.videoWidth ?? v.displayWidth ?? v.naturalWidth ?? v.width;
  const height = v.videoHeight ?? v.displayHeight ?? v.naturalHeight ?? v.height;
  const out: any = { $dom: tag };
  if (typeof width === 'number') out.width = width;
  if (typeof height === 'number') out.height = height;
  if (typeof v.src === 'string' && v.src && !v.src.startsWith('data:')) out.src = v.src.slice(0, 300);
  return out;
}

function isBinary(v: any): boolean
{
  return v instanceof ArrayBuffer || ArrayBuffer.isView(v) ||
    (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer);
}

/**
 * Deep-copies a value passed to WebGPU so later mutation by the page (engines reuse their
 * descriptor objects every frame) does not change what we recorded. GPU objects stay as live
 * references; binary data is summarized, except short numeric arrays (dynamic offsets etc.).
 */
export function clone(v: any, depth = 0): any
{
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t !== 'object') return t === 'function' ? undefined : v;
  if (depth > 12) return '[…]';
  const tag = tagOf(v);
  if (HANDLE_TYPES.has(tag)) return v;
  if (isBinary(v))
  {
    if (ArrayBuffer.isView(v) && !(v instanceof DataView) && (v as any).length <= 16)
    {
      return Array.from(v as any);
    }
    return { $bytes: v.byteLength, $type: tag };
  }
  if (DOM_SOURCES.has(tag)) return domSummary(v, tag);
  if (typeof Node !== 'undefined' && v instanceof Node) return { $dom: tag };
  if (Array.isArray(v)) return v.map((x) => clone(x, depth + 1));
  if (typeof v[Symbol.iterator] === 'function')
  {
    return Array.from(v as Iterable<any>, (x) => clone(x, depth + 1));
  }
  const out: any = {};
  for (const k in v)
  {
    const x = v[k];
    if (x === undefined || typeof x === 'function') continue;
    out[k] = clone(x, depth + 1);
  }
  return out;
}

/** Converts recorded data to JSON: GPU objects become {$ref: id} and are added to `refs`. */
export function ser(v: any, refs: Set<object>, depth = 0): any
{
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = typeof v;
  if (t === 'number') return Number.isFinite(v) ? v : String(v);
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'bigint') return v.toString();
  if (t !== 'object') return undefined;
  if (depth > 40) return '[…]';
  const tag = tagOf(v);
  if (HANDLE_TYPES.has(tag))
  {
    refs.add(v);
    return { $ref: idOf(v) };
  }
  if (isBinary(v)) return { $bytes: v.byteLength, $type: tag };
  if (DOM_SOURCES.has(tag)) return domSummary(v, tag);
  if (Array.isArray(v))
  {
    return v.map((x) =>
    {
      const s = ser(x, refs, depth + 1);
      return s === undefined ? null : s;
    });
  }
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), ser(x, refs, depth + 1)]));
  if (typeof v[Symbol.iterator] === 'function') return Array.from(v as Iterable<any>, (x) => ser(x, refs, depth + 1));
  const out: any = {};
  for (const k in v)
  {
    const s = ser(v[k], refs, depth + 1);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

/** Bytes of a BufferSource argument (as passed to writeBuffer / writeTexture). */
export function bytesOf(data: any, offset?: number, size?: number): Uint8Array | null
{
  try
  {
    if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer))
    {
      const start = offset ?? 0;
      const len = size ?? data.byteLength - start;
      return new Uint8Array(data, start, len);
    }
    if (ArrayBuffer.isView(data))
    {
      // For typed arrays, offset/size are in elements.
      const elem = (data as any).BYTES_PER_ELEMENT ?? 1;
      const start = data.byteOffset + (offset ?? 0) * elem;
      const len = size !== undefined ? size * elem : data.byteLength - (offset ?? 0) * elem;
      return new Uint8Array(data.buffer, start, len);
    }
  }
  catch
  {
    // fall through
  }
  return null;
}

export function toBase64(bytes: Uint8Array): string
{
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
  {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(s);
}
