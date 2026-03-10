/**
 * Pipeline type definitions for agentic-harness v2 — Phase 3 (Multi-Pipeline Support).
 *
 * Pipelines are configured in pipelines.json, not in code.
 * Each pipeline defines a sequence of stages; each stage maps to a registered station.
 * An operator can add a new pipeline (content, legal, business) without touching core code.
 */

// ─── Stage ────────────────────────────────────────────────────────────────────

/**
 * A single stage within a pipeline.
 * Stages are traversed in order; the `label` field is the GitHub label
 * that triggers this stage and the `nextLabel` is applied on completion.
 */
export interface PipelineStageConfig {
  /** Station ID — must match a registered station's id field */
  stationId: string;

  /** GitHub label that triggers this stage (e.g. 'station:intake', 'pipeline:content') */
  label: string;

  /**
   * GitHub label applied on completion to advance the issue to the next stage.
   * null = terminal stage — issue is done after this station completes.
   */
  nextLabel: string | null;

  /** Override the station's default Claude model for this stage only */
  model?: string;

  /** Override the station's default concurrency limit for this stage */
  concurrency?: number;

  /** Override the station's default lock TTL (ms) for this stage */
  ttl?: number;
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

/**
 * A pipeline is a named sequence of stages that an issue flows through.
 * Different teams (software, content, legal) can run different pipelines
 * by configuring pipelines.json — no code changes required.
 */
export interface PipelineConfig {
  /** Unique pipeline identifier (e.g. 'software', 'content', 'business') */
  id: string;

  /** Human-readable display name */
  name: string;

  /** Optional description shown in docs / logs */
  description?: string;

  /** Ordered list of pipeline stages */
  stages: PipelineStageConfig[];

  /**
   * The GitHub label that starts this pipeline (entry stage label).
   * For the software pipeline this is 'station:intake'.
   * For a content pipeline this might be 'pipeline:content'.
   */
  entryLabel: string;

  /**
   * The terminal GitHub label applied when the pipeline completes.
   * Typically 'station:done'.
   */
  doneLabel: string;

  /**
   * Strategy for detecting whether an issue belongs to this pipeline:
   *   'label'    — check issue.labels for detectValue (e.g. 'pipeline:content')
   *   'manifest' — check issue.manifest field for detectValue
   *   'default'  — this pipeline is the fallback when no other pipeline matches
   */
  detectFn?: 'label' | 'manifest' | 'default';

  /**
   * Value used by detectFn:
   *   For 'label'    → the exact label string to look for (e.g. 'pipeline:content')
   *   For 'manifest' → a dot-notation path (e.g. 'project_type=article') — reserved for future use
   *   For 'default'  → not used
   */
  detectValue?: string;
}

// ─── PipelinesConfig ──────────────────────────────────────────────────────────

/**
 * Top-level shape of pipelines.json.
 * Loaded once at startup and injected into FactoryContext.
 */
export interface PipelinesConfig {
  /** Pipeline ID to use when no pipeline:* label is found and no detectFn matches */
  default: string;

  /** All configured pipelines */
  pipelines: PipelineConfig[];
}
