import { createToolRegistry, type ToolContext } from './registry';
import { studioTools } from './tools';

export { createToolRegistry, defineTool, missingRequirements } from './registry';
export type { Availability, CallContext, Tool, ToolContext, ToolRegistry } from './registry';
export { studioTools } from './tools';
/** Registry of every Studio tool (T127). */
export const studioToolRegistry = (ctx: ToolContext) => createToolRegistry(ctx, studioTools);
