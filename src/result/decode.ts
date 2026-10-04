// Decoding of buffer bytes: WGSL-typed values (via wgsl_reflect), vertex formats, indices.

import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import type { CaptureJSON } from '../shared/protocol';

const reflectCache = new Map<number, WgslReflect | null>();

export function reflectModule(cap: CaptureJSON, moduleId: number | undefined): WgslReflect | null
{
  if (moduleId === undefined) return null;
  if (reflectCache.has(moduleId)) return reflectCache.get(moduleId)!;
  let r: WgslReflect | null = null;
  try
  {
    const code = cap.objects[moduleId]?.code;
    if (code) r = new WgslReflect(code);
  }
  catch (e)
  {
    console.warn('wgsl_reflect could not parse module', moduleId, e);
  }
  reflectCache.set(moduleId, r);
  return r;
}

export function resetReflectCache(): void
{
  reflectCache.clear();
}

// ---------------------------------------------------------------------------

export interface Field
{
  name: string;
  type: string;
  offset: number;
  /** Scalar / vector values. */
  values?: (number | string)[];
  /** Matrix: columns of values. */
  matrix?: number[][];
  children?: Field[];
  truncated?: number;
  missing?: boolean;
}

function scalarOf(name: string, format: any): string
{
  const m = name.match(/^(?:vec[234]|mat[234]x[234])([fhiu])$/);
  if (m) return { f: 'f32', h: 'f16', i: 'i32', u: 'u32' }[m[1]]!;
  return format?.name ?? 'f32';
}

function f16(bits: number): number
{
  const s = bits & 0x8000 ? -1 : 1;
  const e = (bits >> 10) & 0x1f;
  const f = bits & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

function readScalar(dv: DataView, off: number, t: string): number | string
{
  if (off < 0 || off + (t === 'f16' ? 2 : 4) > dv.byteLength) return '—';
  switch (t)
  {
    case 'f32': return dv.getFloat32(off, true);
    case 'i32': return dv.getInt32(off, true);
    case 'u32': return dv.getUint32(off, true);
    case 'f16': return f16(dv.getUint16(off, true));
    case 'bool': return dv.getUint32(off, true) ? 'true' : 'false';
    default: return dv.getFloat32(off, true);
  }
}

const MAX_ARRAY = 256;

export function decodeType(type: any, dv: DataView, offset: number, name: string, depth = 0): Field
{
  const typeName: string = type?.getTypeName ? type.getTypeName() : type?.name ?? '?';
  const field: Field = { name, type: typeName, offset };
  if (!type || depth > 12) return field;
  if (offset >= dv.byteLength)
  {
    field.missing = true;
    return field;
  }

  if (type.isStruct)
  {
    field.children = (type.members ?? []).map((m: any) => decodeType(m.type, dv, offset + m.offset, m.name, depth + 1));
    return field;
  }
  if (type.isArray)
  {
    const stride = type.stride || type.format?.size || 4;
    let count = type.count;
    if (!count) count = Math.max(0, Math.floor((dv.byteLength - offset) / stride));
    const shown = Math.min(count, MAX_ARRAY);
    field.children = [];
    for (let i = 0; i < shown; i++)
    {
      if (offset + i * stride >= dv.byteLength) break;
      field.children.push(decodeType(type.format, dv, offset + i * stride, `[${i}]`, depth + 1));
    }
    if (count > shown) field.truncated = count - shown;
    return field;
  }

  const base: string = type.name ?? '';
  if (base === 'atomic' && type.format) return { ...decodeType(type.format, dv, offset, name, depth + 1), type: typeName };

  let m = base.match(/^vec([234])[fhiu]?$/);
  if (m)
  {
    const n = Number(m[1]);
    const st = scalarOf(base, type.format);
    const sz = st === 'f16' ? 2 : 4;
    field.values = Array.from({ length: n }, (_, i) => readScalar(dv, offset + i * sz, st));
    return field;
  }
  m = base.match(/^mat([234])x([234])[fh]?$/);
  if (m)
  {
    const cols = Number(m[1]);
    const rows = Number(m[2]);
    const st = scalarOf(base, type.format);
    const sz = st === 'f16' ? 2 : 4;
    const colStride = (rows === 2 ? 2 : 4) * sz;
    field.matrix = [];
    for (let c = 0; c < cols; c++)
    {
      const col: number[] = [];
      for (let r = 0; r < rows; r++)
      {
        const v = readScalar(dv, offset + c * colStride + r * sz, st);
        col.push(typeof v === 'number' ? v : NaN);
      }
      field.matrix.push(col);
    }
    return field;
  }
  if (['f32', 'i32', 'u32', 'f16', 'bool'].includes(base))
  {
    field.values = [readScalar(dv, offset, base)];
    return field;
  }
  return field;
}

// ---------------------------------------------------------------------------
// Vertex formats

interface VF { kind: 'uint' | 'sint' | 'unorm' | 'snorm' | 'float'; bits: number; count: number; special?: string }

export function parseVertexFormat(f: string): VF | null
{
  if (f === 'unorm10-10-10-2') return { kind: 'unorm', bits: 32, count: 4, special: '1010102' };
  if (f === 'unorm8x4-bgra') return { kind: 'unorm', bits: 8, count: 4, special: 'bgra' };
  const m = f.match(/^(uint|sint|unorm|snorm|float)(8|16|32)(?:x([234]))?$/);
  if (!m) return null;
  return { kind: m[1] as VF['kind'], bits: Number(m[2]), count: m[3] ? Number(m[3]) : 1 };
}

export function vertexFormatSize(f: string): number
{
  const p = parseVertexFormat(f);
  if (!p) return 4;
  if (p.special === '1010102') return 4;
  return (p.bits / 8) * p.count;
}

export function readVertex(dv: DataView, off: number, format: string): (number | string)[]
{
  const p = parseVertexFormat(format);
  if (!p) return ['?'];
  if (off + vertexFormatSize(format) > dv.byteLength) return ['—'];
  if (p.special === '1010102')
  {
    const v = dv.getUint32(off, true);
    return [(v & 1023) / 1023, ((v >> 10) & 1023) / 1023, ((v >> 20) & 1023) / 1023, ((v >>> 30) & 3) / 3];
  }
  const out: number[] = [];
  const bytes = p.bits / 8;
  for (let i = 0; i < p.count; i++)
  {
    const o = off + i * bytes;
    let v = 0;
    if (p.bits === 8)
    {
      if (p.kind === 'sint' || p.kind === 'snorm') v = dv.getInt8(o);
      else v = dv.getUint8(o);
      if (p.kind === 'unorm') v /= 255;
      if (p.kind === 'snorm') v = Math.max(-1, v / 127);
    }
    else if (p.bits === 16)
    {
      if (p.kind === 'float') v = f16(dv.getUint16(o, true));
      else if (p.kind === 'sint' || p.kind === 'snorm') v = dv.getInt16(o, true);
      else v = dv.getUint16(o, true);
      if (p.kind === 'unorm') v /= 65535;
      if (p.kind === 'snorm') v = Math.max(-1, v / 32767);
    }
    else
    {
      if (p.kind === 'float') v = dv.getFloat32(o, true);
      else if (p.kind === 'sint') v = dv.getInt32(o, true);
      else v = dv.getUint32(o, true);
    }
    out.push(v);
  }
  if (p.special === 'bgra') [out[0], out[2]] = [out[2], out[0]];
  return out;
}
