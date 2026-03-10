/**
 * Stations barrel export
 *
 * Exports all station classes, the registry, and shared base types.
 * QA stall-guard helpers (getLastQAInfo, hasBuildMovedSinceLastQA) are
 * exported from './qa/index.js' directly when needed.
 */

export { SpecStation } from './spec/index.js';
export { DesignStation } from './design/index.js';
export { BuildStation, DEFAULT_TEMPLATE_REGISTRY, getTemplateRegistry, resolveTemplate } from './build/index.js';
export { QAStation } from './qa/index.js';
export { BugfixStation } from './bugfix/index.js';
export { BaseStation } from './base.js';
export type { ShouldProcessResult, FactoryContext, FactoryEnv } from './base.js';
export { StationRegistry } from './registry.js';
