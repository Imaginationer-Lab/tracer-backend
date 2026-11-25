// HTTP 응답 계약. 프론트와 같이 쓰는 타입이라 엔진 내부 타입을 import하지 않는다.
// 명세: docs/api.md

export type ProviderId = 'supabase' | 'stripe' | 'aws-s3';

export type StepKey = 'repo' | 'files' | 'detect';
export type StepState = 'pending' | 'running' | 'done' | 'failed';

export interface RepoRef {
  owner: string;
  name: string;
  branch: string;
  commit: string;
}

export type ErrorCode =
  | 'INVALID_REPO_URL'
  | 'REPO_NOT_ACCESSIBLE'
  | 'GITHUB_RATE_LIMITED'
  | 'GITHUB_UNAVAILABLE'
  | 'ANALYSIS_NOT_FOUND'
  | 'STATUS_UNAVAILABLE'
  | 'DEMO_EVENT_INVALID';

export interface ApiError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  resetAt?: string;
}

export interface ProviderSummary {
  id: ProviderId;
  name: string;
  role: string;
  fileCount: number;
  /** declared-only: 의존성 선언만 있고 코드에서 쓰는 곳은 못 찾음 */
  usage: 'used' | 'declared-only';
  statusSupport: 'live' | 'none';
}

export type SkipReason = 'too-large' | 'minified' | 'parse-error';

export type FileEntry =
  | { path: string; state: 'analyzed'; matches: { provider: ProviderId; line: number }[] }
  | { path: string; state: 'skipped'; reason: SkipReason }
  | { path: string; state: 'other' };

export interface AnalysisResult {
  providers: ProviderSummary[];
  files: FileEntry[];
  summary: { analyzed: number; skipped: number };
}

export interface Analysis {
  id: string;
  status: 'running' | 'done' | 'failed';
  repo: RepoRef;
  steps: { key: StepKey; state: StepState }[];
  error: ApiError | null;
  result: AnalysisResult | null;
}

export type EvidenceKind = 'call' | 'http' | 'import' | 'type' | 'setting' | 'config' | 'url' | 'manifest' | 'llm';

export interface CodeFacts {
  /** try/catch, .catch(), except 등으로 감싸져 있는지 */
  errorHandling: boolean;
  retry: boolean;
  timeout: boolean;
  /** 응답 상태 코드를 확인하는지 (res.ok, raise_for_status, IsSuccessStatusCode 등) */
  statusCheck: boolean;
}

export interface EvidenceItem {
  path: string;
  line: number;
  language: string;
  reason: { kind: EvidenceKind; label: string };
  snippet: { startLine: number; lines: string[] };
  facts: CodeFacts | null;
}

export interface ProviderDetail {
  provider: { id: ProviderId; name: string; statusPageUrl: string | null };
  evidence: EvidenceItem[];
}

export interface ProviderStatus {
  providerId: ProviderId;
  state: 'operational' | 'degraded' | 'outage' | 'maintenance' | 'unknown';
  description: string;
  fetchedAt: string;
}

export interface DemoEvent {
  providerId: ProviderId;
  title: string;
  httpStatus: number;
  occurredAt: string;
}
