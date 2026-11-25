// 환경변수 → 설정. 값이 이상하면 서버를 띄우지 않고 바로 알린다.

export interface AppConfig {
  port: number;
  /** 없으면 GitHub 비인증 한도(IP당 시간당 60회)로 동작 */
  githubToken: string | null;
  databaseUrl: string;
  analyzerThreads: number;
  /** 대기열이 이보다 길면 새 분석을 받지 않는다 */
  analyzerQueue: number;
  analysisTimeoutMs: number;
  rateLimit: { burst: number; refillSeconds: number };
  /** 앞단 프록시를 믿을지 (X-Forwarded-For). Fastify trustProxy 값 그대로 */
  trustProxy: boolean | number | string;
  demoEventFile: string;
  maxTarballBytes: number;
  maxRepoFiles: number;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 1): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${key} must be an integer >= ${min} (got "${raw}")`);
  return n;
}

function trustProxy(raw: string | undefined): AppConfig['trustProxy'] {
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  return /^\d+$/.test(raw) ? Number(raw) : raw; // 홉 수 또는 신뢰할 주소 목록
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required (postgres://user:pass@host:5432/db)');
  return {
    port: int(env, 'PORT', 3000),
    githubToken: env.GITHUB_TOKEN || null,
    databaseUrl,
    analyzerThreads: int(env, 'ANALYZER_THREADS', 2),
    analyzerQueue: int(env, 'ANALYZER_QUEUE', 20),
    analysisTimeoutMs: int(env, 'ANALYSIS_TIMEOUT_SECONDS', 120) * 1000,
    rateLimit: { burst: int(env, 'RATE_LIMIT_BURST', 3), refillSeconds: int(env, 'RATE_LIMIT_REFILL_SECONDS', 60) },
    trustProxy: trustProxy(env.TRUST_PROXY),
    demoEventFile: env.DEMO_EVENT_FILE || 'data/demo-event.json',
    maxTarballBytes: int(env, 'MAX_TARBALL_MB', 50) * 1024 * 1024,
    maxRepoFiles: int(env, 'MAX_REPO_FILES', 20000),
  };
}
