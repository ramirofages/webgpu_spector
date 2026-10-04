// Minimal WGSL syntax highlighter producing DOM nodes (no innerHTML).

const KEYWORDS = new Set([
  'alias', 'break', 'case', 'const', 'const_assert', 'continue', 'continuing', 'default', 'diagnostic', 'discard',
  'else', 'enable', 'false', 'fn', 'for', 'if', 'let', 'loop', 'override', 'requires', 'return', 'struct', 'switch',
  'true', 'var', 'while', 'uniform', 'storage', 'read', 'write', 'read_write', 'function', 'private', 'workgroup',
  'push_constant', 'immediate'
]);

const TYPES = /^(bool|f16|f32|i32|u32|vec[234][fhiu]?|mat[234]x[234][fh]?|array|atomic|ptr|sampler|sampler_comparison|texture_[a-z0-9_]+)$/;

const BUILTIN_FNS = new Set([
  'abs', 'acos', 'acosh', 'all', 'any', 'arrayLength', 'asin', 'asinh', 'atan', 'atan2', 'atanh', 'bitcast', 'ceil', 'clamp',
  'cos', 'cosh', 'countLeadingZeros', 'countOneBits', 'countTrailingZeros', 'cross', 'degrees', 'determinant', 'distance',
  'dot', 'dpdx', 'dpdxCoarse', 'dpdxFine', 'dpdy', 'dpdyCoarse', 'dpdyFine', 'exp', 'exp2', 'extractBits', 'faceForward',
  'firstLeadingBit', 'firstTrailingBit', 'floor', 'fma', 'fract', 'frexp', 'fwidth', 'insertBits', 'inverseSqrt', 'ldexp',
  'length', 'log', 'log2', 'max', 'min', 'mix', 'modf', 'normalize', 'pack2x16float', 'pack4x8snorm', 'pack4x8unorm', 'pow',
  'quantizeToF16', 'radians', 'reflect', 'refract', 'reverseBits', 'round', 'saturate', 'select', 'sign', 'sin', 'sinh',
  'smoothstep', 'sqrt', 'step', 'storageBarrier', 'tan', 'tanh', 'textureDimensions', 'textureGather', 'textureGatherCompare',
  'textureLoad', 'textureNumLayers', 'textureNumLevels', 'textureNumSamples', 'textureSample', 'textureSampleBias',
  'textureSampleCompare', 'textureSampleCompareLevel', 'textureSampleGrad', 'textureSampleLevel', 'textureSampleBaseClampToEdge',
  'textureStore', 'transpose', 'trunc', 'unpack2x16float', 'unpack4x8snorm', 'unpack4x8unorm', 'workgroupBarrier',
  'atomicLoad', 'atomicStore', 'atomicAdd', 'atomicSub', 'atomicMax', 'atomicMin', 'atomicAnd', 'atomicOr', 'atomicXor',
  'atomicExchange', 'atomicCompareExchangeWeak', 'textureBarrier', 'workgroupUniformLoad'
]);

const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(@[A-Za-z_][\w]*)|(0[xX][0-9a-fA-F]+[iuh]?|\d+\.\d*(?:[eE][+-]?\d+)?[fh]?|\.\d+(?:[eE][+-]?\d+)?[fh]?|\d+(?:[eE][+-]?\d+)?[iufh]?)|([A-Za-z_][\w]*)|(\s+)|(.)/g;

const CALL = /\s*\(/y;

/** Returns one array of nodes per source line. */
export function highlightLines(code: string): Node[][]
{
  const lines: Node[][] = [[]];
  const push = (text: string, cls?: string) =>
  {
    const parts = text.split('\n');
    parts.forEach((p, i) =>
    {
      if (i > 0) lines.push([]);
      if (!p) return;
      if (cls)
      {
        const s = document.createElement('span');
        s.className = cls;
        s.textContent = p;
        lines[lines.length - 1].push(s);
      }
      else
      {
        lines[lines.length - 1].push(document.createTextNode(p));
      }
    });
  };

  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(code)))
  {
    const [tok, com, attr, num, ident] = m;
    if (com) push(tok, 'tk-com');
    else if (attr) push(tok, 'tk-attr');
    else if (num) push(tok, 'tk-num');
    else if (ident)
    {
      if (KEYWORDS.has(ident)) push(tok, 'tk-kw');
      else if (TYPES.test(ident)) push(tok, 'tk-type');
      else
      {
        CALL.lastIndex = TOKEN.lastIndex;
        if (CALL.test(code)) push(tok, BUILTIN_FNS.has(ident) ? 'tk-bi' : 'tk-fn');
        else push(tok);
      }
    }
    else push(tok);
  }
  return lines;
}
