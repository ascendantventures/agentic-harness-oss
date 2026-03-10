# Custom Pipelines Guide

Angel Factory v2 ships with a **configurable pipeline system**. A pipeline is a sequence
of AI-agent stations that an issue flows through from start to done.

Out of the box you get the **software pipeline** (spec → design → build → QA).
This guide shows you how to create your own pipeline — for content agencies, legal firms,
marketing teams, or any workflow you can describe as a sequence of labelled steps.

---

## What is a Pipeline?

A pipeline is defined in `factory/pipelines.json`. It describes:

1. **Stages** — ordered steps, each driven by a GitHub label
2. **Entry label** — the label that starts the pipeline
3. **Done label** — the terminal label (`station:done` by convention)
4. **Detection** — how the factory knows which issues belong to this pipeline

GitHub labels are the source of truth. When an issue has label `station:intake`,
the software pipeline picks it up. When it has `pipeline:content`, the content
pipeline picks it up.

```
Issue created
   │
   ▼ label: pipeline:content
[ResearchStation]
   │
   ▼ label: station:draft
[DraftStation]
   │
   ▼ label: station:review
[ReviewStation]
   │
   ▼ label: station:publish
[PublishStation]
   │
   ▼ label: station:done  ✅
```

---

## The 5-Minute Quickstart: New Pipeline from Scratch

Let's build a **Legal Pipeline**: intake → review → approve → file.

### Step 1 — Define the pipeline in `pipelines.json`

```json
{
  "default": "software",
  "pipelines": [
    ...existing pipelines...,
    {
      "id": "legal",
      "name": "Legal Document Pipeline",
      "description": "Legal review: intake → review → approve → file",
      "entryLabel": "pipeline:legal",
      "doneLabel": "station:done",
      "detectFn": "label",
      "detectValue": "pipeline:legal",
      "stages": [
        { "stationId": "legalReview",   "label": "pipeline:legal",      "nextLabel": "station:legal-approve" },
        { "stationId": "legalApprove",  "label": "station:legal-approve", "nextLabel": "station:legal-file" },
        { "stationId": "legalFile",     "label": "station:legal-file",   "nextLabel": null }
      ]
    }
  ]
}
```

### Step 2 — Create the station files

```bash
mkdir -p factory/src/stations/legalReview
touch factory/src/stations/legalReview/index.ts
```

```typescript
// factory/src/stations/legalReview/index.ts

import type { Issue, AgentTask } from '../../types/index.js';
import { BaseStation, type FactoryContext, type ShouldProcessResult } from '../base.js';

export class LegalReviewStation extends BaseStation {
  readonly id = 'legalReview';
  readonly label = 'pipeline:legal';
  readonly nextLabel = 'station:legal-approve';
  readonly model = 'claude-sonnet-4-6';
  readonly concurrency = 2;
  readonly ttl = 3600000; // 1 hour

  async shouldProcess(issue: Issue, ctx: FactoryContext): Promise<ShouldProcessResult> {
    const base = await this.baseCheck(issue, ctx);
    if (base) return base;
    return { process: true };
  }

  async buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask> {
    return {
      key: `legalReview-issue-${issue.number}`,
      station: 'legalReview',
      issueNumber: issue.number,
      issueTitle: issue.title,
      model: this.model,
      message: `# Legal Review Agent

Review the document in issue #${issue.number} and post your analysis as a comment.

...your prompt here...

Confirm: Legal review complete for #${issue.number}`,
    };
  }
}
```

Repeat for `legalApprove` and `legalFile`.

### Step 3 — Register the stations

Open `factory/src/stations/registry.ts` and add your stations to `createDefault()`:

```typescript
// In StationRegistry.createDefault():
const { LegalReviewStation } = require('./legalReview/index.js');
const { LegalApproveStation } = require('./legalApprove/index.js');
const { LegalFileStation } = require('./legalFile/index.js');

registry.register(new LegalReviewStation());
registry.register(new LegalApproveStation());
registry.register(new LegalFileStation());
```

### Step 4 — Create GitHub labels

```bash
gh label create "pipeline:legal" --repo your-org/your-repo --color "7057ff"
gh label create "station:legal-approve" --repo your-org/your-repo --color "e4e669"
gh label create "station:legal-file" --repo your-org/your-repo --color "0075ca"
```

### Step 5 — Test it

```bash
# Create a test issue
gh issue create --repo your-org/your-repo \
  --title "Legal Review: Contract #001" \
  --body "Review the attached contract for compliance." \
  --label "pipeline:legal"

# Restart the factory loop — it will pick up the new issue
```

---

## Pipeline Detection: How Issues Are Routed

The factory uses a three-step detection algorithm:

1. **Explicit `pipeline:*` label** — highest priority.
   If an issue has `pipeline:content`, the content pipeline handles it.

2. **`detectFn: "label"` pipelines** — checked in order.
   If a pipeline has `detectFn: "label"` and `detectValue: "pipeline:content"`,
   it activates when the issue has that exact label.

3. **Default pipeline** — fallback.
   If no `pipeline:*` label matches, the pipeline with `detectFn: "default"` is used.
   This is the software pipeline out of the box.

**Note:** A pipeline only processes issues that have labels matching its stages.
Routing is determined per-tick; issues not matching any active stage are skipped.

---

## How to Create a Custom Station

Every station is a TypeScript class that extends `BaseStation`:

```typescript
import { BaseStation, type FactoryContext, type ShouldProcessResult } from '../base.js';
import type { Issue, AgentTask } from '../../types/index.js';

export class MyStation extends BaseStation {
  // Required fields
  readonly id = 'myStation';              // must match stationId in pipelines.json
  readonly label = 'station:my-trigger';  // GitHub label that triggers this station
  readonly nextLabel = 'station:next';    // GitHub label applied on success
  readonly model = 'claude-sonnet-4-6';   // default model
  readonly concurrency = 1;               // max concurrent agents
  readonly ttl = 3600000;                 // lock TTL in ms

  // Gate: decide if this issue should be processed
  async shouldProcess(issue: Issue, ctx: FactoryContext): Promise<ShouldProcessResult> {
    const base = await this.baseCheck(issue, ctx);
    if (base) return base; // handles skip/paused/phase2
    // ... your custom checks ...
    return { process: true };
  }

  // Build the agent task (the full prompt)
  async buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask> {
    return {
      key: `myStation-issue-${issue.number}`,
      station: this.id,
      issueNumber: issue.number,
      issueTitle: issue.title,
      model: this.model,
      message: `Your full prompt here...`,
    };
  }
}
```

**Files touched to add a station:**
1. `factory/src/stations/<name>/index.ts` — station implementation
2. `factory/src/stations/registry.ts` — add `registry.register(new MyStation())`
3. `factory/pipelines.json` — add stage `{ "stationId": "<name>", ... }`

---

## Real-World Pipeline Examples

### Content Agency Pipeline

```json
{
  "id": "content",
  "name": "Content Pipeline",
  "detectFn": "label",
  "detectValue": "pipeline:content",
  "entryLabel": "pipeline:content",
  "doneLabel": "station:done",
  "stages": [
    { "stationId": "research", "label": "pipeline:content",  "nextLabel": "station:draft" },
    { "stationId": "draft",    "label": "station:draft",     "nextLabel": "station:review" },
    { "stationId": "review",   "label": "station:review",    "nextLabel": "station:publish" },
    { "stationId": "publish",  "label": "station:publish",   "nextLabel": null }
  ]
}
```

### Legal Firm Pipeline

```json
{
  "id": "legal",
  "name": "Legal Review Pipeline",
  "detectFn": "label",
  "detectValue": "pipeline:legal",
  "entryLabel": "pipeline:legal",
  "doneLabel": "station:done",
  "stages": [
    { "stationId": "legalIntake",  "label": "pipeline:legal",       "nextLabel": "station:legal-review" },
    { "stationId": "legalReview",  "label": "station:legal-review",  "nextLabel": "station:legal-approve" },
    { "stationId": "legalApprove", "label": "station:legal-approve", "nextLabel": "station:legal-file" },
    { "stationId": "legalFile",    "label": "station:legal-file",    "nextLabel": null }
  ]
}
```

### Marketing Campaign Pipeline

```json
{
  "id": "marketing",
  "name": "Marketing Campaign Pipeline",
  "detectFn": "label",
  "detectValue": "pipeline:marketing",
  "entryLabel": "pipeline:marketing",
  "doneLabel": "station:done",
  "stages": [
    { "stationId": "brief",     "label": "pipeline:marketing",  "nextLabel": "station:copy" },
    { "stationId": "copy",      "label": "station:copy",         "nextLabel": "station:design-review" },
    { "stationId": "designRev", "label": "station:design-review","nextLabel": "station:campaign-launch" },
    { "stationId": "launch",    "label": "station:campaign-launch", "nextLabel": null }
  ]
}
```

---

## Pipeline-Level Overrides

You can override station defaults per stage in `pipelines.json`:

```json
{
  "stationId": "research",
  "label": "pipeline:content",
  "nextLabel": "station:draft",
  "model": "claude-opus-4-5",    // override: use Opus for this stage
  "concurrency": 3,               // override: allow 3 concurrent research agents
  "ttl": 3600000                  // override: 1-hour lock instead of station default
}
```

Stage overrides take precedence over station defaults without changing station code.

---

## FAQ

**Q: Can a station appear in multiple pipelines?**

Yes. A station like `review` can be used in both a content pipeline and a legal pipeline.
The station's `id` is what matters for registration — the pipeline config controls which
label triggers it. If two pipelines use the same station with different labels, register
the station once and use separate labels.

However: the station's `label` property and the pipeline stage's `label` must agree.
If you reuse a station across pipelines with different trigger labels, you'll need
separate station classes (e.g. `ContentReviewStation` and `LegalReviewStation`).

**Q: Can a pipeline have branches?**

Not yet. Pipelines are linear sequences. Branching (e.g. "if QA fails, go to bugfix
instead of done") requires custom logic in the station's `shouldProcess()` or `buildTask()`
methods. The factory label-flip is still how the agent signals "I'm done, go to X".

Branching support is on the roadmap for v3.

**Q: Can I run the factory with only a content pipeline (no software pipeline)?**

Yes. Remove the software pipeline from `pipelines.json` and change `"default"` to
your pipeline's id. The factory will only scan labels defined in your pipelines.

**Q: Does a pipeline:* label need to also be listed as a stage label?**

Yes — the entry label must appear in exactly one stage's `label` field. The factory
collects all `label` values across all stages to know which GitHub labels to query.

**Q: What happens to issues with no matching pipeline label?**

They are processed by the default pipeline (set by `"default"` in `pipelines.json`).
For the software pipeline, that means issues with `station:intake` are processed normally.

**Q: How do I debug pipeline routing?**

Check the factory log (default: `/tmp/factory-loop.log`, configurable via `FACTORY_LOG` env var). Every tick logs:
- Which labels were scanned
- How many issues were found per label
- Which pipeline/stage each issue was routed to
- Why issues were skipped (locked, at capacity, shouldProcess=false, etc.)

---

## Files Reference

| File | Purpose |
|------|---------|
| `factory/pipelines.json` | Pipeline definitions (edit here to add pipelines) |
| `factory/src/types/pipeline.ts` | TypeScript types for pipelines |
| `factory/src/pipeline/detector.ts` | Pipeline detection logic |
| `factory/src/pipeline/router.ts` | Routes issues to stations across all pipelines |
| `factory/src/stations/registry.ts` | Station registration |
| `factory/src/stations/base.ts` | BaseStation abstract class |
| `factory/src/stations/<name>/index.ts` | Individual station implementations |
