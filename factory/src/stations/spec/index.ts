/**
 * SpecStation — processes issues at 'station:intake', produces 'station:spec'.
 *
 * Ported from makeSpecTask() in factory-loop.js.
 */

import type { Issue, AgentTask } from '../../types/index.js';
import { BaseStation, type FactoryContext, type ShouldProcessResult } from '../base.js';
import { getSubmissionForIssue } from '../../notify/supabase.js';

export class SpecStation extends BaseStation {
  readonly id = 'spec';
  readonly label = 'station:intake';
  readonly nextLabel = 'station:spec';
  readonly model = 'claude-sonnet-4-6';
  readonly concurrency = 3; // No session lock contention with claude CLI
  readonly ttl = 1800000; // 30 min

  async shouldProcess(issue: Issue, ctx: FactoryContext): Promise<ShouldProcessResult> {
    // 1. Base checks: skip/paused/phase2
    const base = await this.baseCheck(issue, ctx);
    if (base) return base;

    // 2. Manifest check (skipped for internal/change/standalone)
    const manifest = this.manifestCheck(issue, ctx.env);
    if (manifest) return manifest;

    return { process: true };
  }

  async buildTask(issue: Issue, ctx: FactoryContext): Promise<AgentTask> {
    // Fetch submission to check for attached docs
    const supabaseUrl = ctx.env.supabaseUrl;
    const supabaseKey = ctx.env.supabaseKey;
    const submission = await getSubmissionForIssue(
      issue.number,
      supabaseUrl,
      supabaseKey,
      ctx.log,
    ).catch(() => null);
    const attachedDocs = (submission as any)?.manifest?.attached_docs ?? [];

    const SUPABASE_SERVICE_KEY = supabaseKey;
    const SUPABASE_URL = supabaseUrl;

    // Build doc fetch block — always first step when docs are present
    const docFetchSteps =
      attachedDocs.length > 0
        ? `## Step 1 — Fetch attached requirements documents (PRIMARY SOURCE)

The client attached ${attachedDocs.length} requirements document(s) during intake. Fetch and read them BEFORE doing anything else. These are the authoritative source of truth for requirements.

${attachedDocs
  .map(
    (d: any, i: number) => `### Document ${i + 1}: ${d.name} (${(d.word_count ?? 0).toLocaleString()} words)
\`\`\`bash
curl -s "${SUPABASE_URL}/storage/v1/object/project-docs/${d.text_path}" \\
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \\
  > /tmp/attached-doc-${i + 1}.txt
wc -w /tmp/attached-doc-${i + 1}.txt
cat /tmp/attached-doc-${i + 1}.txt
\`\`\``,
  )
  .join('\n\n')}

Read every word of each document. Then proceed to Step 2.

Use the attached documents as the PRIMARY requirements source. Only infer or ask about what is genuinely missing or ambiguous.`
        : '';

    const stepOffset = attachedDocs.length > 0 ? 2 : 1;

    return {
      key: `spec-issue-${issue.number}`,
      station: 'spec',
      issueNumber: issue.number,
      issueTitle: issue.title,
      model: 'haiku',
      message: `You are a SPEC agent for the factory pipeline.

${docFetchSteps}

## Step ${stepOffset} — Read the GitHub issue

\`\`\`bash
gh issue view ${issue.number} --repo ${ctx.env.repo}
\`\`\`

The issue body contains the client intake manifest with project signals, selected skills, and tech stack. Use it alongside any attached documents.

## Step ${stepOffset + 1} — Read known build patterns before writing spec

If a build-patterns.md file exists in your workspace, read it now.

Apply these patterns proactively in the spec you are about to write:
- Define ALL DB column names in a naming conventions table — be consistent (hoa_id everywhere, not hoa_id in some places and community_id in others)
- Flag every table that has an auth trigger with a note: BUILD must use upsert() not insert()
- Define ALL Supabase Storage bucket names in one place in the spec — BUILD will create lib/storage.ts constants
- For every API route, list ALL roles that have access (not just "admin") — prevent role check drift
- Mark every external service (Stripe, Twilio, etc.) in Prerequisites as ⚠️ Needs setup — QA will skip gracefully

## Step ${stepOffset + 2} — Write the spec to /tmp/spec-issue-${issue.number}.md

Write a complete, BUILD-actionable technical specification including:
- **Project summary** — what is being built and why
- **Architecture decisions** — stack choices, hosting, key constraints
- **Database schema** — a dedicated \`## Migration SQL\` section with complete, runnable Postgres SQL: CREATE TABLE statements with all columns, indexes, triggers (always SECURITY DEFINER), and RLS policies. BUILD will run this directly via \`supabase db push\`. SPEC owns tables+triggers+indexes. BUILD owns RLS. Always apply PATTERN 2 (upsert triggers) and PATTERN 11 (SECURITY DEFINER) from build-patterns.md.
  - ⚠️ **Table isolation:** ALL tables MUST be prefixed with the project slug (e.g. issue "Todo App" → \`todo_items\`, NOT \`todos\`). NEVER create unprefixed tables like \`profiles\`, \`users\`, \`tasks\` — these collide with shared projects.
  - ⚠️ **NEVER replace \`auth.*\` triggers** (e.g. \`handle_new_user\`) that may already exist. Use ON CONFLICT DO NOTHING and prefixed tables instead.
- **API routes** — Next.js App Router endpoints with request/response shapes
- **Key React components** — component tree and responsibilities
- **Requirements** in REQ-/AC- format:
  - \`REQ-[PREFIX]-NNN: Title\`
  - User story: "As a [role], I want [action] so that [value]"
  - Acceptance Criteria: \`AC-NNN.1: When X, shall Y\` — testable, specific, verifiable
- **Pre-written Playwright E2E test specs** — actual test code for critical workflows
- **## Prerequisites** — THIS SECTION IS MANDATORY. List every dependency that must be in place BEFORE QA can run:
  - Every required environment variable (name, where to get it, whether it's available or needs client input)
  - Every external service/API the app calls (Stripe, Twilio, Sport80, etc.) — is it configured? Does it need a key from the client?
  - Every open question that MUST be answered before BUILD starts — do NOT leave ambiguous requirements for BUILD to guess
  - Mark each item as: ✅ Ready | ⚠️ Needs setup | ❌ Blocked (needs client input)
  - If any item is ❌ Blocked — the spec should NOT be approved until it's resolved
  Format:
  \`\`\`
  ## Prerequisites
  | Dependency | Status | Notes |
  |---|---|---|
  | NEXT_PUBLIC_SUPABASE_URL | ✅ Ready | Auto-configured |
  | STRIPE_SECRET_KEY | ⚠️ Needs setup | Client must create Stripe account |
  | SPORT80_API_TOKEN | ❌ Blocked | Waiting on client to provide |
  \`\`\`
- **## Phase Scope** — THIS SECTION IS MANDATORY. The factory ships Phase 1 immediately. Phase 2+ are follow-up issues. This prevents BUILD from getting blocked on complex integrations.
  - **Phase 1 (BUILD NOW):** Core product features — auth, CRUD, main UI flows, basic integrations already configured. Everything BUILD can ship without external blockers.
  - **Phase 2 (DEFERRED):** External service integrations (Stripe, Twilio, DocuSign, OAuth providers), compliance-sensitive modules (IOLTA, legal/financial reporting), white-label/custom domain infrastructure, anything marked ❌ Blocked in Prerequisites.
  - **Rule:** If a feature requires a client-provided API key, a third-party account, compliance review, or significant infrastructure setup → Phase 2. Ship it later as a new issue.
  - **Rule:** Phase 1 must be a complete, usable product on its own — not a skeleton waiting for Phase 2.
  Format:
  \`\`\`
  ## Phase Scope
  ### ✅ Phase 1 — Build Now
  | Feature | Notes |
  |---|---|
  | Core CRUD + auth | All tables, RLS, login/signup |
  | Main UI flows | Dashboard, list views, detail pages, forms |
  | ... | |

  ### ❌ Phase 2 — Deferred
  | Feature | Reason |
  |---|---|
  | Stripe billing | Needs client Stripe account + webhook setup |
  | Email notifications | Needs Resend domain verification |
  | ... | |
  \`\`\`
- **Open questions** — genuine blockers that must be resolved before BUILD starts
- **Size estimate** — S / M / L / XL with reasoning
- **Selected skills and install commands** from the manifest

## Step ${stepOffset + 3} — Post spec + update state

\`\`\`bash
# Post spec as GitHub comment
gh issue comment ${issue.number} --repo ${ctx.env.repo} --body "$(cat /tmp/spec-issue-${issue.number}.md)"

# Flip station label
gh issue edit ${issue.number} --repo ${ctx.env.repo} \\
  --remove-label "station:intake" --add-label "station:spec"

# Tag complexity based on spec (create labels if needed, then apply)
# Rules:
#   complexity:simple  — <5 REQs, no payments, no real-time, no multi-role auth
#   complexity:medium  — 5-9 REQs, OR has auth/bookings but no payments/AI
#   complexity:complex — 10+ REQs, OR has payments/AI/multi-role/integrations
#
# Count your REQs, check for payment_required/auth_required in manifest, then run ONE of:
gh label create "complexity:simple"  --repo ${ctx.env.repo} --color "0075ca" 2>/dev/null || true
gh label create "complexity:medium"  --repo ${ctx.env.repo} --color "e4e669" 2>/dev/null || true
gh label create "complexity:complex" --repo ${ctx.env.repo} --color "d73a4a" 2>/dev/null || true
# Then add the appropriate label — pick EXACTLY ONE:
# gh issue edit ${issue.number} --repo ${ctx.env.repo} --add-label "complexity:simple"
# gh issue edit ${issue.number} --repo ${ctx.env.repo} --add-label "complexity:medium"
# gh issue edit ${issue.number} --repo ${ctx.env.repo} --add-label "complexity:complex"

# Update Supabase station
curl -s -X PATCH \\
  "${SUPABASE_URL}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}" \\
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \\
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"station": "spec"}'
\`\`\`

Do NOT set spec_approved — the owner must review and approve before BUILD starts.

# Push spec_ready card to client thread so approval button appears in chat
SUBMISSION_ID=$(curl -s \\
  "${SUPABASE_URL}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}&select=id" \\
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \\
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null)

if [ -n "$SUBMISSION_ID" ]; then
  # Use jq to safely build JSON — shell interpolation breaks on special chars in spec content
  SPEC_SUMMARY=$(head -5 /tmp/spec-issue-${issue.number}.md 2>/dev/null | tr '\\n' ' ')
  FACTORY_SECRET=$(grep FACTORY_SECRET ~/.bashrc | cut -d= -f2)
  PUSH_PAYLOAD=$(jq -n \\
    --arg summary "$SPEC_SUMMARY" \\
    --arg sid "$SUBMISSION_ID" \\
    '{
      type: "spec_card",
      content: "Your spec is ready — review and approve to start building.",
      payload: {
        type: "spec_card",
        station: "spec",
        specSummary: $summary,
        phase1Features: [],
        phase2Features: [],
        prerequisites: [],
        submissionId: $sid,
        sizeEstimate: "S"
      }
    }')
  curl -s -X POST "${ctx.env.factoryAppUrl}/api/threads/$SUBMISSION_ID/push" \\
    -H "Content-Type: application/json" \\
    -H "x-factory-secret: $FACTORY_SECRET" \\
    -d "$PUSH_PAYLOAD"
  echo "✓ Pushed spec_ready card to thread $SUBMISSION_ID"
fi

## Step ${stepOffset + 4} — Create Phase 2 tracking issue (if Phase 2 has any features)

If your spec has a "Phase 2 — Deferred" section with at least one feature, create a tracking issue NOW so deferred work is never lost:

\`\`\`bash
# Extract Phase 2 features from your spec and create a tracking issue
gh issue create --repo ${ctx.env.repo} \\
  --title "[Phase 2] #${issue.number} — <Project Name> — Deferred Features" \\
  --body "## Phase 2 Tracking — linked to #${issue.number}

Phase 1 is live. These features were deferred and should be built as a follow-up once Phase 1 is approved.

### Deferred Features
<!-- Paste the Phase 2 table from the spec here -->

### To kick off Phase 2
1. Client approves Phase 1 delivery
2. Add label \`station:intake\` to this issue  
3. Factory will auto-queue SPEC → DESIGN → BUILD

### Prerequisites for Phase 2
<!-- List any client accounts, API keys, or config needed before Phase 2 can start -->" \\
  --label "station:spec,type:phase2"
\`\`\`

Only create the Phase 2 issue if there are actual deferred features. Skip this step if everything fit in Phase 1.`,
    };
  }
}
