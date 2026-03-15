import { readFileSync, existsSync } from 'fs';
import type { AgentResult } from '../types/index.js';

export interface SupabaseHeaders {
  apikey: string;
  Authorization: string;
  [key: string]: string;
}

export function makeSupabaseHeaders(serviceRoleKey: string): SupabaseHeaders {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
}

export async function pushToThread(
  submissionId: string,
  type: string,
  payload: unknown,
  content: string,
  factoryAppUrl: string,
  factorySecret: string,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await fetch(`${factoryAppUrl}/api/threads/${submissionId}/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-factory-secret': factorySecret,
      },
      body: JSON.stringify({ type, payload, content }),
    });
  } catch (e: any) {
    log(`pushToThread non-blocking error: ${e.message}`);
  }
}

export async function pushChangeRequestStatus(
  issueNumber: number,
  status: string,
  supabaseUrl: string,
  supabaseKey: string,
  log: (msg: string) => void,
): Promise<void> {
  const headers = makeSupabaseHeaders(supabaseKey);
  try {
    const patchBody: Record<string, unknown> = { status };
    if (status === 'complete') patchBody.completed_at = new Date().toISOString();

    // 1. Update change_requests record
    const res = await fetch(
      `${supabaseUrl}/rest/v1/change_requests?github_issue_number=eq.${issueNumber}`,
      {
        method: 'PATCH',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(patchBody),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log(
        `pushChangeRequestStatus #${issueNumber} → ${status} failed: ${res.status} ${text}`,
      );
      return;
    }

    const records = await res.json().catch(() => []) as Array<Record<string, unknown>>;
    const cr = records[0];
    log(`pushChangeRequestStatus #${issueNumber} → ${status}`);

    if (!cr) return;

    // 2. Update thread_message payload so card shows correct state on reload
    if (cr.thread_message_id) {
      await fetch(
        `${supabaseUrl}/rest/v1/thread_messages?message_id=eq.${cr.thread_message_id}`,
        {
          method: 'PATCH',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            payload: {
              type: 'change_confirmation',
              changeRequestId: cr.id,
              summary: cr.summary,
              changeType: cr.change_type,
              details: cr.details,
              estimatedMinutes: cr.estimated_minutes,
              workItems: cr.work_items,
              scopeRating: cr.scope_rating,
              status,
            },
          }),
        },
      ).catch(() => null);
    }

    // 3. Post completion notification to thread
    if (status === 'complete' && cr.submission_id) {
      const threadRes = await fetch(
        `${supabaseUrl}/rest/v1/project_threads?submission_id=eq.${cr.submission_id}&select=thread_id`,
        { headers },
      );
      const threads = await threadRes.json().catch(() => []) as Array<{ thread_id?: string }>;
      const threadId = threads[0]?.thread_id;
      if (threadId) {
        await fetch(`${supabaseUrl}/rest/v1/thread_messages`, {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            thread_id: threadId,
            role: 'assistant',
            message_type: 'text',
            content: `✅ **Change complete!** "${cr.summary}" has been shipped and is live on your project. Let me know if anything looks off or if you'd like any tweaks.`,
          }),
        }).catch(() => null);
        log(`Pushed completion notification to thread for CR #${issueNumber}`);
      }
    }
  } catch (e: any) {
    log(`pushChangeRequestStatus error: ${e.message}`);
  }
}

export async function writeTokenUsageAsync(
  issueNumber: number,
  station: string,
  logFile: string,
  supabaseUrl: string,
  supabaseKey: string,
  log: (msg: string) => void,
): Promise<void> {
  try {
    if (!logFile || !existsSync(logFile)) return;

    // Read last non-empty line of logFile (JSON result envelope from --output-format json)
    const content = readFileSync(logFile, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) return;
    const lastLine = lines[lines.length - 1].trim();

    let parsed: AgentResult;
    try {
      parsed = JSON.parse(lastLine) as AgentResult;
    } catch {
      return;
    }

    // Only process result envelopes with usage data
    if (parsed.type !== 'result' || !parsed.usage) return;

    const usage = parsed.usage;
    const costUsd = parsed.total_cost_usd ?? 0;

    // Resolve submission
    const submission = await getSubmissionForIssue(issueNumber, supabaseUrl, supabaseKey);
    if (!submission?.id || !(submission as any).created_by) {
      log(`[token-usage] No submission/user for issue #${issueNumber} — skipping row`);
      return;
    }

    const headers = makeSupabaseHeaders(supabaseKey);
    const row = {
      submission_id: submission.id,
      user_id: (submission as any).created_by,
      station,
      model: parsed.model ?? 'unknown',
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
      cost_usd: costUsd,
      num_turns: parsed.num_turns ?? 0,
      duration_ms: parsed.duration_ms ?? 0,
    };

    const res = await fetch(`${supabaseUrl}/rest/v1/project_token_usage`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log(`[token-usage] Supabase insert failed (${res.status}): ${errText}`);
    } else {
      log(
        `[token-usage] ✅ Wrote usage for #${issueNumber} station=${station} cost=$${costUsd.toFixed(4)}`,
      );
    }
  } catch (e: any) {
    log(`[token-usage] Error writing usage for #${issueNumber}: ${e.message}`);
  }
}

export async function getSubmissionForIssue(
  issueNumber: number,
  supabaseUrl: string,
  supabaseKey: string,
  _log?: (msg: string) => void,
): Promise<Record<string, unknown> | null> {
  const headers = makeSupabaseHeaders(supabaseKey);
  try {
    const url = `${supabaseUrl}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issueNumber}&select=id,tech_stack,project_type,manifest,created_by`;
    const res = await fetch(url, { headers });
    const rows = await res.json() as Array<Record<string, unknown>>;
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function isSpecApproved(
  issue: { number: number } | number,
  supabaseUrl: string,
  supabaseKey: string,
  _log?: (msg: string) => void,
): Promise<boolean> {
  const issueNumber = typeof issue === 'number' ? issue : issue.number;
  const headers = makeSupabaseHeaders(supabaseKey);
  try {
    const url = `${supabaseUrl}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issueNumber}&spec_approved=eq.true&select=id`;
    const res = await fetch(url, { headers });
    const rows = await res.json() as unknown[];
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

export async function isClientApproved(
  issue: { number: number },
  supabaseUrl: string,
  supabaseKey: string,
  log: (msg: string) => void,
): Promise<boolean> {
  const headers = makeSupabaseHeaders(supabaseKey);
  try {
    const url = `${supabaseUrl}/rest/v1/submissions?github_issue_url=ilike.*%2Fissues%2F${issue.number}&review_status=eq.approved&select=id`;
    const res = await fetch(url, { headers });
    const rows = await res.json() as unknown[];
    return Array.isArray(rows) && rows.length > 0;
  } catch (e: any) {
    log(
      `Warning: Supabase approval check failed for #${issue.number}: ${e.message}`,
    );
    // Fail open — if Supabase is unreachable, don't block the queue
    return true;
  }
}

/**
 * Upsert harness heartbeat row to Supabase.
 * Called once per loop tick so the dashboard can show live status.
 */
export async function upsertHarnessHeartbeat(
  supabaseUrl: string,
  serviceRoleKey: string,
  pid: number,
  activeAgents: number,
  lockSnapshot: Record<string, unknown>,
  log: (msg: string) => void,
): Promise<void> {
  if (!supabaseUrl || !serviceRoleKey) return;
  try {
    const headers = {
      ...makeSupabaseHeaders(serviceRoleKey),
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    };
    const body = JSON.stringify({
      id: 'main',
      pid,
      active_agents: activeAgents,
      lock_snapshot: lockSnapshot,
      status: 'running',
      last_seen: new Date().toISOString(),
    });
    const res = await fetch(`${supabaseUrl}/rest/v1/harness_heartbeat`, {
      method: 'POST',
      headers,
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log(`[heartbeat] upsert failed ${res.status}: ${text}`);
    }
  } catch (e: any) {
    log(`[heartbeat] non-blocking error: ${e.message}`);
  }
}
