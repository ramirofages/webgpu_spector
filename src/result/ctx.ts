import type { CaptureJSON } from '../shared/protocol';
import type { Model, TreeNode } from './model';
import type { CaptureStore } from './store';

export interface ShaderStageRef
{
  stage: string;
  module: number;
  entryPoint?: string;
}

export interface Ctx
{
  cap: CaptureJSON;
  model: Model;
  store: CaptureStore;
  obj(ref: any): any;
  openObject(id: number): void;
  openShader(stages: ShaderStageRef[], focus?: number, highlight?: { group: number; binding: number }): void;
  openImage(snapId: number, title?: string): void;
  selectNode(node: TreeNode, scroll?: boolean): void;
  snapUses(snapId: number): { node: TreeNode; role: string }[];
  showTab(name: string): void;
}

export function refId(ref: any): number | undefined
{
  return ref && typeof ref === 'object' && typeof ref.$ref === 'number' ? ref.$ref : undefined;
}
