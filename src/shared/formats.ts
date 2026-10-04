// Texture format helpers shared by the hook (blit selection) and the results page.

export type SampleKind = 'float' | 'uint' | 'sint' | 'depth' | 'stencil';

const DEPTH_FORMATS = new Set(['depth16unorm', 'depth24plus', 'depth24plus-stencil8', 'depth32float', 'depth32float-stencil8']);
const STENCIL_FORMATS = new Set(['stencil8', 'depth24plus-stencil8', 'depth32float-stencil8']);

export function hasDepthAspect(format: string): boolean
{
  return DEPTH_FORMATS.has(format);
}

export function hasStencilAspect(format: string): boolean
{
  return STENCIL_FORMATS.has(format);
}

export function isDepthStencilFormat(format: string): boolean
{
  return DEPTH_FORMATS.has(format) || STENCIL_FORMATS.has(format);
}

/** The format a view of `format` gets when created with `aspect`. */
export function aspectFormat(format: string, aspect: string | undefined): string
{
  if (aspect === 'depth-only')
  {
    if (format === 'depth24plus-stencil8') return 'depth24plus';
    if (format === 'depth32float-stencil8') return 'depth32float';
  }
  if (aspect === 'stencil-only' && hasStencilAspect(format)) return 'stencil8';
  return format;
}

export function sampleKind(format: string, aspect?: string): SampleKind
{
  if (aspect === 'stencil-only') return 'stencil';
  if (format === 'stencil8') return 'stencil';
  if (DEPTH_FORMATS.has(format)) return 'depth';
  if (/^(r|rg|rgba|rgb10a2)\d*uint$/.test(format) || format.endsWith('uint')) return 'uint';
  if (format.endsWith('sint')) return 'sint';
  return 'float';
}

export function isSrgbFormat(format: string): boolean
{
  return format.endsWith('-srgb');
}

export function isFloatFormat(format: string): boolean
{
  return format.includes('float') && !DEPTH_FORMATS.has(format);
}

/** Number of meaningful channels, used to show single-channel formats as gray. */
export function channelCount(format: string): number
{
  if (/^(r8|r16|r32)/.test(format) && !format.startsWith('rg')) return 1;
  if (/^rg(8|16|32)/.test(format) && !format.startsWith('rgb')) return 2;
  if (format.startsWith('bc4-r') || format.startsWith('eac-r11')) return 1;
  if (format.startsWith('bc5-rg') || format.startsWith('eac-rg11')) return 2;
  return 4;
}

export const BUFFER_USAGE_FLAGS: [number, string][] = [
  [0x0001, 'MAP_READ'],
  [0x0002, 'MAP_WRITE'],
  [0x0004, 'COPY_SRC'],
  [0x0008, 'COPY_DST'],
  [0x0010, 'INDEX'],
  [0x0020, 'VERTEX'],
  [0x0040, 'UNIFORM'],
  [0x0080, 'STORAGE'],
  [0x0100, 'INDIRECT'],
  [0x0200, 'QUERY_RESOLVE']
];

export const TEXTURE_USAGE_FLAGS: [number, string][] = [
  [0x01, 'COPY_SRC'],
  [0x02, 'COPY_DST'],
  [0x04, 'TEXTURE_BINDING'],
  [0x08, 'STORAGE_BINDING'],
  [0x10, 'RENDER_ATTACHMENT'],
  [0x20, 'TRANSIENT_ATTACHMENT']
];

export const SHADER_STAGE_FLAGS: [number, string][] = [
  [0x1, 'VERTEX'],
  [0x2, 'FRAGMENT'],
  [0x4, 'COMPUTE']
];

export function flagNames(value: number, table: [number, string][]): string
{
  if (typeof value !== 'number') return String(value);
  const names = table.filter(([bit]) => (value & bit) !== 0).map(([, n]) => n);
  return names.length ? names.join(' | ') : '0';
}
