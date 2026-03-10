import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PipelineDetector } from '../../factory/src/pipeline/detector.js';
import type { PipelinesConfig } from '../../factory/src/types/pipeline.js';
import type { Issue } from '../../factory/src/types/index.js';

// Minimal mock registry — detector only uses it for type compatibility
const mockRegistry = {} as any;

const pipelinesConfig: PipelinesConfig = {
  default: 'software',
  pipelines: [
    {
      id: 'software',
      name: 'Software Factory',
      entryLabel: 'station:intake',
      doneLabel: 'station:done',
      detectFn: 'default',
      stages: [
        { stationId: 'spec', label: 'station:intake', nextLabel: 'station:spec' },
        { stationId: 'design', label: 'station:spec', nextLabel: 'station:design' },
        { stationId: 'build', label: 'station:design', nextLabel: 'station:build' },
        { stationId: 'qa', label: 'station:build', nextLabel: 'station:qa' },
        { stationId: 'bugfix', label: 'station:bugfix', nextLabel: 'station:build' },
      ],
    },
    {
      id: 'content',
      name: 'Content Pipeline',
      entryLabel: 'pipeline:content',
      doneLabel: 'station:done',
      detectFn: 'label',
      detectValue: 'pipeline:content',
      stages: [
        { stationId: 'research', label: 'pipeline:content', nextLabel: 'station:draft' },
        { stationId: 'draft', label: 'station:draft', nextLabel: 'station:review' },
        { stationId: 'review', label: 'station:review', nextLabel: 'station:publish' },
        { stationId: 'publish', label: 'station:publish', nextLabel: 'station:done' },
      ],
    },
  ],
};

function makeIssue(labels: string[]): Issue {
  return {
    number: 1,
    title: 'Test issue',
    labels,
    body: '',
    isInternal: false,
    isChangeRequest: false,
    buildRepo: null,
  } as Issue;
}

describe('PipelineDetector', () => {
  const detector = new PipelineDetector(pipelinesConfig, mockRegistry);

  describe('detect()', () => {
    it('detects default pipeline for issues with no pipeline label', () => {
      const issue = makeIssue(['station:intake']);
      const result = detector.detect(issue);
      assert.equal(result.id, 'software');
    });

    it('detects explicit pipeline:content label', () => {
      const issue = makeIssue(['pipeline:content']);
      const result = detector.detect(issue);
      assert.equal(result.id, 'content');
    });

    it('prioritizes explicit pipeline label over detectFn', () => {
      const issue = makeIssue(['pipeline:software', 'station:intake']);
      const result = detector.detect(issue);
      assert.equal(result.id, 'software');
    });

    it('falls back to default when pipeline label is unknown', () => {
      const issue = makeIssue(['pipeline:nonexistent', 'station:intake']);
      const result = detector.detect(issue);
      assert.equal(result.id, 'software');
    });

    it('detects content pipeline via detectFn=label', () => {
      const issue = makeIssue(['pipeline:content', 'station:draft']);
      const result = detector.detect(issue);
      assert.equal(result.id, 'content');
    });
  });

  describe('getCurrentStage()', () => {
    it('finds the correct stage by label', () => {
      const issue = makeIssue(['station:intake']);
      const pipeline = detector.detect(issue);
      const stage = detector.getCurrentStage(issue, pipeline);
      assert.ok(stage);
      assert.equal(stage.stationId, 'spec');
      assert.equal(stage.label, 'station:intake');
    });

    it('returns null when no stage matches', () => {
      const issue = makeIssue(['unrelated-label']);
      const pipeline = pipelinesConfig.pipelines[0]!;
      const stage = detector.getCurrentStage(issue, pipeline);
      assert.equal(stage, null);
    });

    it('matches bugfix stage correctly', () => {
      const issue = makeIssue(['station:bugfix']);
      const pipeline = pipelinesConfig.pipelines[0]!;
      const stage = detector.getCurrentStage(issue, pipeline);
      assert.ok(stage);
      assert.equal(stage.stationId, 'bugfix');
      assert.equal(stage.nextLabel, 'station:build');
    });
  });

  describe('resolve()', () => {
    it('resolves both pipeline and stage', () => {
      const issue = makeIssue(['station:spec']);
      const { pipeline, stage } = detector.resolve(issue);
      assert.equal(pipeline.id, 'software');
      assert.ok(stage);
      assert.equal(stage.stationId, 'design');
    });

    it('resolves pipeline with null stage for unmatched labels', () => {
      const issue = makeIssue(['some-random-label']);
      const { pipeline, stage } = detector.resolve(issue);
      assert.equal(pipeline.id, 'software');
      assert.equal(stage, null);
    });
  });
});
