/**
 * PipelineDetector — determines which pipeline an issue belongs to
 * and which stage within that pipeline the issue is currently at.
 *
 * Detection order:
 *   1. Explicit `pipeline:*` label on the issue  →  match by pipeline id
 *   2. Pipeline whose detectFn='label' matches a label on the issue
 *   3. Fall back to the default pipeline id from PipelinesConfig
 */

import type { Issue } from '../types/index.js';
import type { PipelineConfig, PipelineStageConfig, PipelinesConfig } from '../types/pipeline.js';
import type { StationRegistry } from '../stations/registry.js';

export class PipelineDetector {
  constructor(
    private readonly pipelinesConfig: PipelinesConfig,
    private readonly registry: StationRegistry,
  ) {}

  /**
   * Detect which pipeline an issue belongs to.
   *
   * Algorithm:
   *   1. Look for an explicit `pipeline:<id>` label.
   *      If found and the id matches a configured pipeline, use it.
   *   2. Scan all pipelines with detectFn='label'; use first match.
   *   3. Fall back to pipelinesConfig.default.
   */
  detect(issue: Issue): PipelineConfig {
    const { pipelines, default: defaultId } = this.pipelinesConfig;

    // 1. Explicit pipeline:* label (highest priority)
    const pipelineLabel = issue.labels.find((l) => l.startsWith('pipeline:'));
    if (pipelineLabel) {
      const id = pipelineLabel.replace('pipeline:', '');
      const explicit = pipelines.find((p) => p.id === id);
      if (explicit) return explicit;
    }

    // 2. detectFn='label' pipelines — check detectValue against issue labels
    const labelMatch = pipelines.find(
      (p) =>
        p.detectFn === 'label' &&
        p.detectValue !== undefined &&
        issue.labels.includes(p.detectValue),
    );
    if (labelMatch) return labelMatch;

    // 3. Default pipeline
    const defaultPipeline = pipelines.find((p) => p.id === defaultId);
    if (!defaultPipeline) {
      throw new Error(
        `PipelineDetector: default pipeline "${defaultId}" not found in pipelines.json`,
      );
    }
    return defaultPipeline;
  }

  /**
   * Return the stage within the pipeline that matches the issue's current labels.
   * Returns null if the issue has no label matching any stage in this pipeline.
   */
  getCurrentStage(issue: Issue, pipeline: PipelineConfig): PipelineStageConfig | null {
    return pipeline.stages.find((s) => issue.labels.includes(s.label)) ?? null;
  }

  /**
   * Convenience: detect pipeline AND stage in one call.
   * Returns { pipeline, stage } — stage may be null.
   */
  resolve(issue: Issue): { pipeline: PipelineConfig; stage: PipelineStageConfig | null } {
    const pipeline = this.detect(issue);
    const stage = this.getCurrentStage(issue, pipeline);
    return { pipeline, stage };
  }
}
