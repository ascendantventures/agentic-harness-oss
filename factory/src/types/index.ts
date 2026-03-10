/**
 * ALL shared interfaces for agentic-harness v2
 * Flat file (not split into sub-files) per Phase 1 spec.
 */

// ─── GitHub Types ──────────────────────────────────────────────────────────────

export interface IssueLabel {
  name: string;
  color?: string;
  description?: string;
}

/** Raw GitHub issue as returned by `gh` CLI */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  url: string;
  labels: IssueLabel[];
  state?: 'open' | 'closed';
  createdAt?: string;
  updatedAt?: string;
  comments?: IssueComment[];
}

export interface IssueComment {
  body: string;
  createdAt?: string;
  author?: { login: string };
}

/** Parsed client manifest from issue body JSON block */
export interface ClientManifest {
  business: string;
  problem: string;
  tech_stack?: string[] | string;
  project_type?: string;
  selected_skills?: string[];
  payment_required?: boolean;
  auth_required?: boolean;
  attached_docs?: AttachedDoc[];
}

export interface AttachedDoc {
  name: string;
  text_path: string;
  word_count?: number;
}

/** Enriched issue with parsed labels/manifest/flags */
export interface Issue {
  // Raw GitHub data
  raw: GitHubIssue;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[]; // just the names for easy .includes()

  // Parsed metadata
  manifest: ClientManifest | null;
  isChangeRequest: boolean; // title starts with [Change]
  isInternal: boolean;      // has type:internal label
  isPhase2: boolean;        // has type:phase2 label
  complexity: 'simple' | 'medium' | 'complex' | null;

  // Extracted from body for change requests
  buildRepo?: string;      // build_repo: owner/repo
  submissionId?: string;   // submission_id: uuid
}

// ─── Lock Types ────────────────────────────────────────────────────────────────

/** Single lock entry in the lock file */
export interface LockEntry {
  /** Epoch ms when lock was acquired */
  ts: number;
  /** Issue number */
  issue: number;
  /** Station ID */
  station: string;
  /** Agent PID (for dead lock detection) */
  pid?: number;
  /** Agent log file path */
  logFile?: string;
  /** Is this a complexity:simple issue? (shorter TTL) */
  simple?: boolean;
}

/** Lock file structure */
export type LockFile = Record<string, LockEntry>;

// ─── Backoff Types ─────────────────────────────────────────────────────────────

export interface BackoffEntry {
  failures: number;
  /** Epoch ms when backoff expires */
  until: number;
}

export type BackoffFile = Record<string, BackoffEntry>;

// ─── Agent Types ───────────────────────────────────────────────────────────────

/** Task definition passed to the agent spawner */
export interface AgentTask {
  /** Unique key for locking (e.g., 'spec-issue-123') */
  key: string;
  /** Station ID */
  station: string;
  /** Issue being processed */
  issueNumber: number;
  issueTitle: string;
  /** Model hint (haiku/sonnet/opus — resolved at spawn time) */
  model?: string;
  /** Full prompt for the agent */
  message: string;
  /** Env overrides (optional) */
  env?: Record<string, string | undefined>;
  /** Log file path (optional override) */
  logFile?: string;
}

/** Handle returned by spawnAgent */
export interface AgentHandle {
  pid: number | undefined;
  logFile: string;
  startedAt: number; // epoch ms
  task: AgentTask;
}

/** Result from running a station on an issue */
export interface StationResult {
  success: boolean;
  /** Label to transition to on success */
  nextLabel?: string;
  /** Labels to remove */
  removeLabels?: string[];
  /** Error info if failed */
  error?: {
    message: string;
    recoverable: boolean;
    shouldRetry: boolean;
  };
  /** Metadata for logging/tracking */
  meta?: {
    duration_ms?: number;
    tokens_used?: number;
    model?: string;
    agentPid?: number;
    logFile?: string;
  };
}

// ─── Config Types ──────────────────────────────────────────────────────────────

/** Per-station config from config.json */
export interface StationConfig {
  model?: string;
  concurrency?: number;
  lockTTL?: number;
  lockTTLSimple?: number;
  timeout?: number;
  settings?: Record<string, unknown>;
}

/** Concurrency limits */
export interface ConcurrencyConfig {
  maxTasksPerRun: number;
  build?: number;
  qa?: number;
  design?: number;
  spec?: number;
  bugfix?: number;
}

/** GitHub-related config */
export interface GitHubConfig {
  repo: string;
  issueLabels?: Record<string, string>;
}

/** Template registry config — maps template IDs to repos */
export interface TemplatesConfig {
  /** GitHub owner for template repos and build repos (e.g., 'your-org') */
  owner: string;
  /** GitHub owner/repo for internal feature builds (optional) */
  internalRepo?: string;
  /** Template definitions keyed by template ID */
  entries: Record<string, TemplateConfig>;
}

/** Full config.json shape */
export interface Config {
  stations: Record<string, StationConfig>;
  github: GitHubConfig;
  concurrency: ConcurrencyConfig;
  /** Template repo configuration */
  templates?: TemplatesConfig;
  /** Notification config (optional) */
  notify?: {
    discord?: { webhookUrl?: string; enabled?: boolean };
    supabase?: { url?: string; serviceRoleKey?: string; enabled?: boolean };
  };
}

// ─── Context Types ─────────────────────────────────────────────────────────────

/** DI container passed throughout the system */
export interface FactoryContext {
  config: Config;
  env: FactoryEnv;
  log: (msg: string) => void;
  // Service references set after construction
  locks?: LockManager;
  backoff?: BackoffManager;
  keys?: KeyManager;
}

/** Resolved environment variables */
export interface FactoryEnv {
  repo: string;
  supabaseUrl: string;
  supabaseKey: string;
  factorySecret: string;
  factoryAppUrl: string;
  discordWebhookUrl: string;
  useClaudeCli: boolean;
  logFile: string;
}

// ─── Service Class Interfaces ──────────────────────────────────────────────────

export interface LockManager {
  getLocks(): LockFile;
  setLock(key: string, meta: Omit<LockEntry, 'ts'>): void;
  removeLock(key: string): void;
  isLocked(key: string): boolean;
  countActiveLocks(station: string): number;
  cleanDeadLocks(): void;
}

export interface BackoffManager {
  load(): Map<string, BackoffEntry>;
  save(map: Map<string, BackoffEntry>): void;
  isInCrashBackoff(key: string): boolean;
  recordCrash(key: string, fast: boolean, logFile?: string): void;
  clearBackoff(key: string): void;
  getBackoff(key: string): BackoffEntry | undefined;
}

export interface KeyManager {
  loadKeys(): KeysConfig | null;
  getCurrentKey(): string;
  rotateKey(reason?: string): void;
  validateKey(): Promise<{ ok: boolean; reason?: string }>;
  buildAgentEnv(apiKey: string): NodeJS.ProcessEnv;
}

export interface KeysConfig {
  keys: Array<{ key: string; account: string }>;
  currentIndex: number;
}

// ─── Template Types ────────────────────────────────────────────────────────────

export interface TemplateConfig {
  repo: string;
  deployTarget: string;
  matchStacks: string[];
  matchTypes: string[];
}

// ─── Supabase Types ────────────────────────────────────────────────────────────

export interface Submission {
  id: string;
  created_by: string;
  station?: string;
  tech_stack?: string[];
  project_type?: string;
  manifest?: ClientManifest;
  live_url?: string;
  spec_approved?: boolean;
  review_status?: string;
}

export interface ChangeRequest {
  id: string;
  github_issue_number: number;
  submission_id?: string;
  thread_message_id?: string;
  status: string;
  summary?: string;
  change_type?: string;
  details?: string;
  estimated_minutes?: number;
  work_items?: unknown;
  scope_rating?: number;
  completed_at?: string;
}

// ─── Agent Result (from --output-format json log) ─────────────────────────────

export interface AgentResult {
  type: 'result';
  success: boolean;
  model: string;
  is_error?: boolean;
  result?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd: number;
  num_turns: number;
  duration_ms: number;
}
