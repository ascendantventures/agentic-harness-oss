# Failure Mode Analysis — Agentic Harness + Angel-Agents UI

> **Purpose:** Systematic catalog of failure modes across the harness pipeline and UI surface.
> Each entry includes: trigger, current behavior, expected behavior, severity, and test coverage status.
>
> **Legend:** 🔴 Critical (data loss / silent failure) | 🟠 High (user-visible stall) | 🟡 Medium (degraded UX) | 🟢 Low (noise / logging gap)
> **Test status:** ✅ Covered | ⚠️ Partial | ❌ Not tested

---

## 1. Provision Station

### FM-001 — Supabase ACTIVE_HEALTHY timeout
- **Trigger:** New Supabase project created but doesn't reach ACTIVE_HEALTHY within 2 min (24 × 5s polls)
- **Current behavior:** `station:stuck` — operator must manually recover
- **Expected:** Retry up to 3× with exponential backoff, then `station:stuck`
- **Severity:** 🟠 High
- **Test:** ❌ Not tested
- **Fix target:** Extend timeout to 10 min (120 × 5s), add `station:provision-retry` for transient failures

### FM-002 — Supabase project creation hard failure (bad token / org quota)
- **Trigger:** Management API returns 4xx on project create
- **Current behavior:** `station:stuck` with comment
- **Expected:** ✅ Correct — hard failure should block
- **Severity:** 🟠 High
- **Test:** ❌ Not tested

### FM-003 — Supabase API keys fetch fails after project created
- **Trigger:** Project is ACTIVE_HEALTHY but `/api-keys` returns error
- **Current behavior:** `station:stuck` — project exists but keys unretrievable
- **Expected:** Retry 3× before giving up; project is not cleaned up (orphaned)
- **Severity:** 🟠 High
- **Test:** ❌ Not tested

### FM-004 — Vercel project not found by name
- **Trigger:** Build agent deployed to default project (`build-work`) instead of named project
- **Current behavior:** Silently skips env injection (logs "Could not find Vercel project"), advances to QA anyway
- **Expected:** Should flag as warning in GitHub comment; QA will catch 500s
- **Severity:** 🟡 Medium (QA catches it, but wastes a QA run)
- **Test:** ❌ Not tested — this is exactly what happened with #215

### FM-005 — Migration partial failure (some SQLs fail)
- **Trigger:** One of N migration files fails (e.g. policy already exists, syntax error)
- **Current behavior:** Non-fatal — continues to next migration, logs warning
- **Expected:** ✅ Correct for idempotent errors; wrong for schema errors
- **Severity:** 🟡 Medium
- **Test:** ❌ Not tested

### FM-006 — Build repo not found in issue comments
- **Trigger:** Build completed but no GitHub repo URL in comments (agent didn't comment build success)
- **Current behavior:** Silently advances to `station:provisioned` with no Supabase project
- **Expected:** Should flag `station:stuck` — app won't work without DB
- **Severity:** 🔴 Critical (silent failure — app appears deployed but has no DB)
- **Test:** ❌ Not tested

### FM-007 — Provision runs twice (race condition)
- **Trigger:** Loop tick fires while provision is already running (directRun + lock gap)
- **Current behavior:** `findExistingProject` should deduplicate, but keys/Vercel injection runs twice
- **Expected:** Idempotent double-run — upsert logic should handle it
- **Severity:** 🟡 Medium
- **Test:** ❌ Not tested

---

## 2. Build Station

### FM-008 — TypeScript compilation fails
- **Trigger:** Agent writes code with TS errors
- **Current behavior:** `tsc --noEmit` fails → build station halted, issue stays at `station:build`
- **Expected:** ✅ Correct — artifact gate + reconciler will push to bugfix
- **Severity:** 🟢 Low
- **Test:** ⚠️ Partial (happens naturally in prod)

### FM-009 — `npm run build` fails (runtime error at build time)
- **Trigger:** Next.js build fails (missing env var, import error, etc.)
- **Current behavior:** `vercel build` fails → deploy skipped → issue stays at `station:build`
- **Expected:** ✅ Correct — build gate catches it
- **Severity:** 🟢 Low
- **Test:** ⚠️ Partial

### FM-010 — Vercel deploy succeeds but app returns 500
- **Trigger:** App builds and deploys but crashes at runtime (missing DB, env var typo, etc.)
- **Current behavior:** Build marks COMPLETE, provision runs, QA agent encounters 500s
- **Expected:** QA should catch and bounce to bugfix
- **Severity:** 🟠 High (common; QA is last line of defense)
- **Test:** ❌ Not tested systematically

### FM-011 — PR missing required artifacts (CLAUDE.md / REGRESSION.md)
- **Trigger:** Build agent doesn't include required files in PR
- **Current behavior:** Artifact gate detects missing files, bounces with comment
- **Expected:** ✅ Correct
- **Severity:** 🟢 Low
- **Test:** ⚠️ Partial (gate is live, not explicitly tested)

### FM-012 — Git author email blocks Vercel deploy
- **Trigger:** Commit author email doesn't match Vercel account
- **Current behavior:** Was blocking deploys; fixed with `factory@agenticharness.ai` email
- **Expected:** ✅ Fixed (5644635)
- **Severity:** 🟢 Low (fixed)
- **Test:** ❌ Not regression-tested

---

## 3. QA Station

### FM-013 — QA runs before build completes (premature spawn)
- **Trigger:** Loop picks up `station:provisioned` label while build agent is still mid-flight
- **Current behavior:** Fixed — `build` added to `noFlipStations`
- **Expected:** ✅ Fixed (655117b)
- **Severity:** 🟠 High
- **Test:** ❌ Not regression-tested

### FM-014 — QA comment parsing fails (false PASS)
- **Trigger:** QA agent writes non-standard comment format; UAT check for "QA Report" + "✅ PASS" misses it
- **Current behavior:** UAT skips issue — `No QA PASS found`; issue stalls at `station:qa`
- **Expected:** UAT should have a fallback / more lenient parse
- **Severity:** 🟠 High
- **Test:** ❌ Not tested

### FM-015 — QA PASS but live URL returns 404 or 500
- **Trigger:** QA agent marks PASS without actually verifying live URL (prompt gap)
- **Current behavior:** Passes through to UAT; UAT may catch it via browser
- **Expected:** QA should hard-fail on HTTP != 200 for live URL
- **Severity:** 🔴 Critical (can ship broken apps)
- **Test:** ❌ Not tested

### FM-016 — No build repo in issue, QA auto-passes
- **Trigger:** Internal issue or spec-only issue with no build repo
- **Current behavior:** Silently auto-passes
- **Expected:** ✅ Correct for internal issues; risky for real builds
- **Severity:** 🟡 Medium
- **Test:** ❌ Not tested

---

## 4. UAT Station

### FM-017 — Browser automation fails mid-UAT (network, selector)
- **Trigger:** `agent-browser` tool errors or page doesn't load
- **Current behavior:** Agent may mark PASS with suggestions or partial results
- **Expected:** Should mark FAIL if app can't be navigated
- **Severity:** 🟠 High
- **Test:** ❌ Not tested

### FM-018 — UAT delivery_card push fails silently
- **Trigger:** `/api/threads/{id}/push` returns non-200
- **Current behavior:** No retry, no dead-letter queue — card never appears in UI
- **Expected:** Retry 3×, then write error to thread_messages + alert
- **Severity:** 🔴 Critical (user sees "QA passed — preparing for delivery" forever)
- **Test:** ❌ Not tested

### FM-019 — UAT marks PASS but live_url is null
- **Trigger:** Provision skipped Vercel injection; live_url never set
- **Current behavior:** Delivery card shows null/empty URL
- **Expected:** Should fail UAT if live_url is missing
- **Severity:** 🟠 High
- **Test:** ❌ Not tested

---

## 5. Loop Infrastructure

### FM-020 — Duplicate loop instances
- **Trigger:** Loop restarted without killing previous instance
- **Current behavior:** Fixed — single-instance guard via PID file
- **Expected:** ✅ Fixed (8920056)
- **Severity:** 🔴 Critical (was causing double agent spawns)
- **Test:** ❌ Not regression-tested

### FM-021 — Agent PID dies mid-execution (lock becomes stale)
- **Trigger:** Claude process killed by OOM, SIGKILL, or crash
- **Current behavior:** Lock entry remains with dead PID; next loop tick skips that issue
- **Expected:** Heartbeat detects stale locks (>30 min) and clears them; reconciler should also catch via post-exit hook
- **Severity:** 🟠 High
- **Test:** ❌ Not tested

### FM-022 — Loop exits (crash) while agents are mid-flight
- **Trigger:** Node process crashes or is killed
- **Current behavior:** Agents continue independently; on loop restart, reconciler post-exit sweep picks up orphans
- **Expected:** ✅ Partially handled; lock file may persist
- **Severity:** 🟠 High
- **Test:** ❌ Not tested

### FM-023 — maxTasksPerRun reached — high-priority issue starved
- **Trigger:** 4 long-running agents already active; urgent issue waits
- **Current behavior:** Respects maxTasksPerRun strictly — no priority override
- **Expected:** `priority:urgent` issues should bypass cap (1 extra slot)
- **Severity:** 🟡 Medium
- **Test:** ❌ Not tested

---

## 6. Angel-Agents UI

### FM-024 — Unknown message_type received from harness
- **Trigger:** Harness sends new card type not yet in `ThreadMessageRenderer`
- **Current behavior:** `ThreadMessageRenderer` falls through to `null` — message silently not rendered
- **Expected:** Fallback renderer showing raw content + warning
- **Severity:** 🟡 Medium
- **Test:** ❌ Not tested

### FM-025 — Supabase Realtime disconnects mid-session
- **Trigger:** Network blip or Supabase edge timeout
- **Current behavior:** Client-side polling not implemented — user must refresh to see new messages
- **Expected:** Auto-reconnect with missed message backfill
- **Severity:** 🟠 High
- **Test:** ❌ Not tested

### FM-026 — access_token expired or invalid on approve
- **Trigger:** User clicks Approve after session timeout
- **Current behavior:** Returns 401; UI doesn't handle error state — button may appear stuck
- **Expected:** Show re-auth prompt or clear error message
- **Severity:** 🟠 High
- **Test:** ❌ Not tested

### FM-027 — Concurrent approval (two users approve simultaneously)
- **Trigger:** Two team members click Approve on same spec card at same time
- **Current behavior:** Both requests hit `/api/threads/{id}/approve` — double-advance possible
- **Expected:** Idempotent approval (check `approved` flag before advancing)
- **Severity:** 🟠 High
- **Test:** ❌ Not tested

### FM-028 — delivery_card live_url is broken (404/500) at delivery
- **Trigger:** App was deployed but Supabase env vars missing; user clicks "Open App"
- **Current behavior:** User lands on broken app; no harness feedback loop
- **Expected:** UAT should verify live URL before marking PASS; UI could show health badge
- **Severity:** 🔴 Critical (user-facing)
- **Test:** ❌ Not tested

### FM-029 — submission.station desynced from GitHub label
- **Trigger:** Label flip succeeds but Supabase PATCH fails (network error)
- **Current behavior:** UI shows wrong station; pipeline continues normally
- **Expected:** Station PATCH should be in same transaction as label flip (or reconciler re-syncs)
- **Severity:** 🟡 Medium
- **Test:** ❌ Not tested

### FM-030 — question_card has no answer routing
- **Trigger:** Factory sends `question_card`; user answers via UI
- **Current behavior:** Factory re-reads whole thread on next spawn — answer may be missed if not in expected format
- **Expected:** Explicit answer routing to waiting agent
- **Severity:** 🟠 High (known gap)
- **Test:** ❌ Not tested

---

## Summary

| Severity | Count | Tested |
|----------|-------|--------|
| 🔴 Critical | 5 | 0 |
| 🟠 High | 15 | 0 |
| 🟡 Medium | 7 | 0 |
| 🟢 Low | 3 | 2 partial |
| **Total** | **30** | **~2 partial** |

**Immediate P0 fixes to implement:**
1. FM-006 — Build repo missing → silent no-DB deploy (change `return true` to `station:stuck`)
2. FM-018 — delivery_card push no retry (dead-letter needed)
3. FM-015 — QA PASS without live URL health check
4. FM-001 — Provision timeout too short (2 min → 10 min)
5. FM-004 — Vercel project not found → silent env skip (happened in prod with #215)

---

*Last updated: 2026-03-18 by Forge*
