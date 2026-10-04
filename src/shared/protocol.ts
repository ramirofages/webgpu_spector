// Messages and data shapes shared by the hook (page MAIN world), the content script,
// the background worker, the popup and the results page.

export const HOOK_TAG = 'webgpu-spector:hook';
export const CONTENT_TAG = 'webgpu-spector:content';

export interface CaptureSettings
{
  /** Split render passes after every draw and grab the attachments (the "visual states"). */
  drawSnapshots: boolean;
  /** Longest side, in pixels, of every captured image. */
  snapshotSize: number;
  /** Also grab the depth attachment after every draw. */
  depthSnapshots: boolean;
  /** Grab the textures that bind groups sample, as seen by each pass. */
  textureSnapshots: boolean;
  /** Copy the contents of uniform/storage/vertex/index buffers used by each pass. */
  bufferSnapshots: boolean;
  /** Buffers up to this size are copied whole; larger ones only copy their bound ranges, capped at this size. */
  maxBufferBytes: number;
  /** Total budget for buffer copies in a capture. */
  maxTotalBufferBytes: number;
  /** After this many draws, stop splitting passes (the rest of the frame is still recorded). */
  maxDrawSnapshots: number;
  /** Record a JS stack trace for each draw / dispatch / submit. */
  stackTraces: boolean;
  /** Float render targets (rgba16float etc.) are usually linear: show them sRGB-encoded. */
  floatAsSrgb: boolean;
  /** Store images as lossless WebP (exact pixels, ~4x bigger) instead of high-quality lossy WebP. */
  losslessImages: boolean;
}

export const DEFAULT_SETTINGS: CaptureSettings = {
  drawSnapshots: true,
  snapshotSize: 768,
  depthSnapshots: true,
  textureSnapshots: true,
  bufferSnapshots: true,
  maxBufferBytes: 1 << 20,
  maxTotalBufferBytes: 128 << 20,
  maxDrawSnapshots: 1500,
  stackTraces: true,
  floatAsSrgb: true,
  losslessImages: false
};

export interface CanvasStatus
{
  width: number;
  height: number;
  format: string;
  id: string;
}

export interface PageStatus
{
  webgpu: boolean;
  adapters: number;
  devices: number;
  canvases: CanvasStatus[];
  submits: number;
  lastSubmit: number | null;
  capturing: boolean;
  url: string;
  title: string;
}

export type CapturePhase = 'waiting' | 'recording' | 'reading' | 'encoding' | 'saving' | 'done' | 'error';

export interface CaptureProgress
{
  phase: CapturePhase;
  message: string;
  done?: number;
  total?: number;
}

// ---------------------------------------------------------------------------
// Capture file
// ---------------------------------------------------------------------------

/** A reference to a WebGPU object in the capture's object table. */
export interface Ref { $ref: number }

export interface SnapshotJSON
{
  /** 'color' (rgba8 image), 'depth' (normalized gray image) */
  kind: 'color' | 'depth';
  width: number;
  height: number;
  srcWidth: number;
  srcHeight: number;
  format: string;
  texture: number;
  mip: number;
  layer: number;
  sampleCount: number;
  depthMin?: number;
  depthMax?: number;
  missing?: string;
}

export interface BufferSnapshotJSON
{
  buffer: number;
  ranges: { offset: number; size: number; key: string }[];
  missing?: string;
}

export interface DrawSnaps
{
  /** One snapshot id per color attachment (null when it could not be captured). */
  c: (number | null)[];
  /** Depth attachment snapshot. */
  d?: number | null;
}

export interface DrawState
{
  pipeline: Ref | null;
  bindGroups: { index: number; bindGroup: Ref | null; offsets: number[] }[];
  vertexBuffers: { slot: number; buffer: Ref | null; offset: number; size?: number }[];
  indexBuffer: { buffer: Ref; format: string; offset: number; size?: number } | null;
  viewport?: number[] | null;
  scissor?: number[] | null;
  blendConstant?: any;
  stencilReference?: number | null;
}

export interface CmdJSON
{
  /** Sequence number in the frame. */
  i: number;
  /** Method name (setPipeline, draw, beginRenderPass, writeBuffer...). */
  n: string;
  /** Receiver object. */
  o?: Ref;
  /** Arguments (GPU objects as refs, binary data summarized). */
  a?: any[];
  /** Returned object. */
  r?: Ref;
  /** Index into meta.stacks. */
  st?: number;
  /** Present on draws and dispatches. */
  draw?: { state: DrawState; snap?: DrawSnaps; bundleSnaps?: (DrawSnaps | null)[] };
  /** Present on beginRenderPass / beginComputePass. */
  pass?: PassJSON;
  /** Present on submit: encoder ids, in order (null = command buffer not recorded). */
  cbs?: (number | null)[];
  /** Extra details (writeBuffer data preview etc.). */
  x?: any;
}

export interface PassJSON
{
  kind: 'render' | 'compute';
  cmds: CmdJSON[];
  /** viewId → snapshot of that view as sampled by this pass. */
  texSnaps: Record<string, number>;
  /** bufferId → buffer snapshot as read by this pass. */
  bufSnaps: Record<string, number>;
  /** Snapshot at the end of the pass (when the last draw has none, or the pass has no draws). */
  endSnap?: DrawSnaps;
  split: boolean;
  notes: string[];
}

export interface EncoderJSON
{
  id: number;
  label: string;
  device: Ref;
  cmds: CmdJSON[];
  submitted: boolean;
}

export interface CaptureJSON
{
  version: 1;
  meta: {
    url: string;
    title: string;
    time: number;
    userAgent: string;
    durationMs: number;
    settings: CaptureSettings;
    stats: Record<string, number>;
    warnings: string[];
    stacks: string[];
    trigger: string;
  };
  events: CmdJSON[];
  encoders: Record<string, EncoderJSON>;
  objects: Record<string, any>;
  snapshots: Record<string, SnapshotJSON>;
  bufferSnapshots: Record<string, BufferSnapshotJSON>;
}

export interface CaptureResultMessage
{
  capture: CaptureJSON;
  /** snapshot id → PNG data URL */
  images: Record<string, string>;
  /** buffer range key → base64 */
  buffers: Record<string, string>;
}

export interface CaptureIndexEntry
{
  id: string;
  url: string;
  title: string;
  time: number;
  stats: Record<string, number>;
  keys: string[];
  bytes: number;
}

export const STORAGE_INDEX_KEY = 'captures:index';
export const STORAGE_SETTINGS_KEY = 'settings';
export const MAX_STORED_CAPTURES = 12;
export const MAX_STORED_BYTES = 1536 * 1024 * 1024;
