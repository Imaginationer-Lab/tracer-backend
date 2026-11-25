import { createHash } from 'node:crypto';
import type { Ecosystem, Lang, ProviderId } from './types.js';

// ─── 규칙 스키마 ──────────────────────────────────────────────────────────────
// 규칙은 DB에 JSON으로 저장할 수 있는 데이터다. 엔진이 해석만 하고 실행하지 않는다.
// 모든 문자열 패턴은 '*' 글롭이다 (glob.ts).

export type RuleMatch =
  /** 매니페스트 의존성. maven은 'groupId:artifactId' */
  | { type: 'dependency'; ecosystem: Ecosystem; name: string | string[] }
  /** import · require · using · from x import */
  | { type: 'import'; module: string | string[] }
  /**
   * 호출식. callee는 import 별칭을 풀어낸 이름이다.
   *   import boto3 as b; b.client('s3')  →  'boto3.client'
   *   new S3Client() (import from '@aws-sdk/client-s3')  →  '@aws-sdk/client-s3.S3Client'
   * whenImport: 파일이 이 모듈을 import할 때만 적용 (C# using처럼 이름만으로는 출처를 모를 때)
   */
  | { type: 'call'; callee: string | string[]; arg0?: string; whenImport?: string | string[] }
  /** 필드·매개변수 선언 타입 (Java·C# 주입) */
  | { type: 'type'; name: string | string[]; whenImport?: string | string[] }
  /** 코드·설정 파일에 나온 host. path가 있으면 URL 경로까지 본다 */
  | { type: 'host'; host: string | string[] }
  /** 환경변수·설정 키 (normalizeKey 결과에 대한 글롭) */
  | { type: 'setting'; key: string | string[] };

export interface Rule {
  id: string;
  provider: ProviderId;
  /** 없으면 모든 언어 */
  langs?: Lang[];
  match: RuleMatch;
  source: 'builtin' | 'learned';
  meta?: { createdBy?: string; verifiedOn?: string[]; hits?: number };
}

const LANGS: Lang[] = ['typescript', 'tsx', 'javascript', 'python', 'java', 'csharp'];
const ECOSYSTEMS: Ecosystem[] = ['npm', 'pypi', 'maven', 'nuget'];
export const PROVIDER_IDS: ProviderId[] = ['supabase', 'stripe', 'aws-s3'];

/** DB나 LLM에서 온 규칙을 받기 전에 모양을 검사한다. 너무 넓은 패턴도 여기서 거른다. */
export function validateRule(value: unknown): { ok: true; rule: Rule } | { ok: false; error: string } {
  const r = value as Partial<Rule> | null;
  if (!r || typeof r !== 'object') return { ok: false, error: 'not an object' };
  if (typeof r.id !== 'string' || !/^[\w:.\-/@*]{1,120}$/.test(r.id)) return { ok: false, error: 'bad id' };
  if (!PROVIDER_IDS.includes(r.provider as ProviderId)) return { ok: false, error: 'unknown provider' };
  if (r.langs && (!Array.isArray(r.langs) || r.langs.some((l) => !LANGS.includes(l)))) return { ok: false, error: 'bad langs' };
  if (r.source !== 'builtin' && r.source !== 'learned') return { ok: false, error: 'bad source' };
  const m = r.match as RuleMatch | undefined;
  if (!m || typeof m !== 'object') return { ok: false, error: 'missing match' };

  const patterns: unknown[] = [];
  switch (m.type) {
    case 'dependency':
      if (!ECOSYSTEMS.includes(m.ecosystem)) return { ok: false, error: 'bad ecosystem' };
      patterns.push(m.name);
      break;
    case 'import':
      patterns.push(m.module);
      break;
    case 'call':
      patterns.push(m.callee);
      if (m.arg0 !== undefined) patterns.push(m.arg0);
      if (m.whenImport !== undefined) patterns.push(m.whenImport);
      break;
    case 'type':
      patterns.push(m.name);
      if (m.whenImport !== undefined) patterns.push(m.whenImport);
      break;
    case 'host':
      patterns.push(m.host);
      break;
    case 'setting':
      patterns.push(m.key);
      break;
    default:
      return { ok: false, error: 'unknown match type' };
  }
  for (const p of patterns.flatMap((x) => (Array.isArray(x) ? x : [x]))) {
    if (typeof p !== 'string' || p.length === 0 || p.length > 200) return { ok: false, error: 'bad pattern' };
    // '*'를 빼고 남는 글자가 3자 미만이면 거의 모든 것과 맞는다
    if (p.replace(/\*/g, '').replace(/[^\w]/g, '').length < 2) return { ok: false, error: `pattern too broad: ${p}` };
  }
  return { ok: true, rule: r as Rule };
}

// ─── 공급자 카탈로그 ────────────────────────────────────────────────────────

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  defaultRole: string;
  statusPageUrl: string;
  /** 공개 상태 API (Statuspage 형식). 없으면 "실시간 연동 전" */
  statusApi?: string;
  /** 근거의 호출식·URL 경로로 역할을 더 좁힌다 */
  roles: { callee?: string; path?: string; role: string }[];
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  supabase: {
    id: 'supabase',
    name: 'Supabase',
    defaultRole: '데이터베이스',
    statusPageUrl: 'https://status.supabase.com',
    statusApi: 'https://status.supabase.com/api/v2/status.json',
    roles: [
      { callee: '*.auth.*', role: '로그인' },
      { path: '/auth/*', role: '로그인' },
      { callee: '*.storage.*', role: '파일 저장' },
      { path: '/storage/*', role: '파일 저장' },
    ],
  },
  stripe: {
    id: 'stripe',
    name: 'Stripe',
    defaultRole: '결제',
    statusPageUrl: 'https://status.stripe.com',
    roles: [],
  },
  'aws-s3': {
    id: 'aws-s3',
    name: 'Amazon S3',
    defaultRole: '파일 업로드',
    statusPageUrl: 'https://health.aws.amazon.com/health/status',
    roles: [],
  },
};

// ─── 내장 규칙 ───────────────────────────────────────────────────────────────

const JS: Lang[] = ['typescript', 'tsx', 'javascript'];
let seq = 0;
const rule = (provider: ProviderId, match: RuleMatch, langs?: Lang[]): Rule => ({
  id: `builtin:${provider}:${match.type}:${++seq}`,
  provider,
  match,
  ...(langs ? { langs } : {}),
  source: 'builtin',
});

export const BUILTIN_RULES: Rule[] = [
  // Stripe
  rule('stripe', { type: 'dependency', ecosystem: 'npm', name: ['stripe', '@stripe/*'] }),
  rule('stripe', { type: 'dependency', ecosystem: 'pypi', name: 'stripe' }),
  rule('stripe', { type: 'dependency', ecosystem: 'maven', name: 'com.stripe:*' }),
  rule('stripe', { type: 'dependency', ecosystem: 'nuget', name: 'Stripe.net' }),
  rule('stripe', { type: 'import', module: ['stripe', '@stripe/*'] }, JS),
  rule('stripe', { type: 'import', module: ['stripe', 'stripe.*'] }, ['python']),
  rule('stripe', { type: 'import', module: 'com.stripe.*' }, ['java']),
  rule('stripe', { type: 'import', module: ['Stripe', 'Stripe.*'] }, ['csharp']),
  // Stripe.net은 `using Stripe;` 뒤에 new PaymentIntentService()처럼 이름만 쓴다
  rule('stripe', { type: 'call', callee: '*Service', whenImport: ['Stripe', 'Stripe.*'] }, ['csharp']),
  rule('stripe', { type: 'host', host: ['stripe.com', '*.stripe.com'] }),
  rule('stripe', { type: 'setting', key: '*stripe*' }),

  // Supabase
  rule('supabase', { type: 'dependency', ecosystem: 'npm', name: '@supabase/*' }),
  rule('supabase', { type: 'dependency', ecosystem: 'pypi', name: ['supabase', 'supabase-*'] }),
  rule('supabase', { type: 'dependency', ecosystem: 'nuget', name: ['Supabase', 'supabase-*'] }),
  rule('supabase', { type: 'dependency', ecosystem: 'maven', name: 'io.github.jan-tennert.supabase:*' }),
  rule('supabase', { type: 'import', module: '@supabase/*' }, JS),
  rule('supabase', { type: 'import', module: ['supabase', 'supabase.*'] }, ['python']),
  rule('supabase', { type: 'import', module: ['Supabase', 'Supabase.*'] }, ['csharp']),
  rule('supabase', { type: 'import', module: 'io.github.jan.supabase*' }, ['java']),
  rule('supabase', { type: 'host', host: ['supabase.co', '*.supabase.co', '*.supabase.in'] }),
  rule('supabase', { type: 'setting', key: '*supabase*' }),

  // Amazon S3
  rule('aws-s3', { type: 'dependency', ecosystem: 'npm', name: ['@aws-sdk/client-s3', '@aws-sdk/s3-*', '@aws-sdk/lib-storage'] }),
  rule('aws-s3', { type: 'dependency', ecosystem: 'maven', name: ['software.amazon.awssdk:s3', 'software.amazon.awssdk:s3-*', 'com.amazonaws:aws-java-sdk-s3'] }),
  rule('aws-s3', { type: 'dependency', ecosystem: 'nuget', name: 'AWSSDK.S3' }),
  rule('aws-s3', { type: 'import', module: ['@aws-sdk/client-s3', '@aws-sdk/s3-*', '@aws-sdk/lib-storage'] }, JS),
  rule('aws-s3', { type: 'call', callee: 'aws-sdk.S3' }, JS),
  rule('aws-s3', { type: 'import', module: ['software.amazon.awssdk.services.s3*', 'com.amazonaws.services.s3*'] }, ['java']),
  rule('aws-s3', { type: 'import', module: ['Amazon.S3', 'Amazon.S3.*'] }, ['csharp']),
  rule('aws-s3', { type: 'call', callee: ['AmazonS3Client', 'TransferUtility'] }, ['csharp']),
  rule('aws-s3', { type: 'type', name: ['IAmazonS3', 'AmazonS3Client'] }, ['csharp']),
  // boto3는 AWS 전체 SDK라서 client('s3') 인자로 S3를 구분한다
  rule('aws-s3', { type: 'call', callee: ['*.client', '*.resource'], arg0: 's3', whenImport: ['boto3', 'boto3.*', 'aioboto3'] }, ['python']),
  rule('aws-s3', { type: 'host', host: ['s3.amazonaws.com', '*.s3.amazonaws.com', 's3.*.amazonaws.com', '*.s3.*.amazonaws.com', 's3-*.amazonaws.com', '*.s3-*.amazonaws.com'] }),
  rule('aws-s3', { type: 'setting', key: ['s3', 's3.*', '*.s3', '*.s3.*'] }),
];

export function rulesetVersion(rules: Rule[]): string {
  return createHash('sha1').update(JSON.stringify(rules.map((r) => [r.id, r.provider, r.langs, r.match]))).digest('hex').slice(0, 10);
}

// ─── 공급자가 아닌 의존성 ───────────────────────────────────────────────────
// LLM에 "이건 어떤 서비스냐"고 물을 필요가 없는 흔한 라이브러리. 여기서 빠진 것만 애매 후보가 된다.

export const COMMON_DEPENDENCIES: Record<Ecosystem, string[]> = {
  npm: [
    'react', 'react-*', 'next', 'next-*', '@next/*', 'vue', 'vue-*', 'nuxt', 'svelte', '@sveltejs/*', 'express', 'fastify', 'koa', 'hono',
    '@nestjs/*', 'zod', 'yup', 'joi', 'lodash*', 'date-fns', 'dayjs', 'moment', 'clsx', 'classnames', 'tailwind*', '@tailwindcss/*',
    'postcss', 'autoprefixer', 'typescript', 'tslib', '@types/*', 'eslint*', 'prettier*', 'vite', 'webpack*', '@vitejs/*', '@babel/*',
    'swr', '@tanstack/*', 'zustand', 'jotai', 'redux', '@reduxjs/*', 'immer', 'uuid', 'nanoid', 'dotenv', 'cors', 'helmet', 'body-parser',
    'cookie-parser', 'morgan', 'winston', 'pino*', 'chalk', 'commander', 'yargs', 'react-hook-form', '@hookform/*', 'framer-motion',
    'styled-components', '@emotion/*', '@radix-ui/*', 'lucide-react', '@heroicons/*', 'class-variance-authority', 'tailwind-merge',
    'sharp', 'bcrypt*', 'jsonwebtoken', 'jose', 'next-auth', 'prisma', '@prisma/*', 'drizzle-*', 'mongoose', 'sequelize', 'typeorm', 'pg',
    'mysql2', 'ioredis', 'redis', 'axios', 'ky', 'got', 'ofetch', 'node-fetch', 'undici', 'cross-fetch', 'isomorphic-fetch', 'superagent',
    'vitest', 'jest', '@testing-library/*', 'playwright', '@playwright/*', 'tsx', 'ts-node', 'nodemon', 'concurrently', 'rimraf', 'cross-env',
  ],
  pypi: [
    'fastapi', 'uvicorn*', 'gunicorn', 'starlette', 'pydantic*', 'sqlalchemy', 'alembic', 'psycopg*', 'asyncpg', 'pymysql', 'redis',
    'celery', 'django*', 'flask*', 'jinja2', 'python-dotenv', 'python-multipart', 'requests', 'httpx', 'aiohttp', 'urllib3', 'tenacity',
    'pytest*', 'black', 'ruff', 'mypy', 'isort', 'flake8', 'boto3', 'botocore', 'aioboto3', 'numpy', 'pandas', 'passlib*', 'python-jose*',
    'bcrypt', 'orjson', 'ujson', 'loguru', 'typer', 'click', 'rich',
  ],
  maven: [
    'org.springframework*:*', 'org.projectlombok:*', 'junit:*', 'org.junit*:*', 'org.mockito:*', 'org.assertj:*', 'com.fasterxml*:*',
    'org.slf4j:*', 'ch.qos.logback:*', 'org.postgresql:*', 'com.h2database:*', 'mysql:*', 'com.mysql:*', 'org.mapstruct:*',
    'org.hibernate*:*', 'jakarta.*:*', 'javax.*:*', 'io.github.resilience4j:*', 'org.apache.commons:*', 'commons-*:*', 'com.google.guava:*',
    'com.squareup.okhttp3:*', 'org.flywaydb:*', 'org.liquibase:*', 'io.micrometer:*', 'org.springdoc:*', 'software.amazon.awssdk:bom',
  ],
  nuget: [
    'Microsoft.*', 'System.*', 'Newtonsoft.Json', 'Swashbuckle.*', 'xunit*', 'NUnit*', 'Moq', 'FluentAssertions', 'FluentValidation*',
    'Serilog*', 'AutoMapper*', 'Dapper', 'Npgsql*', 'Polly*', 'MediatR*', 'coverlet.*', 'Refit*', 'AWSSDK.Core',
    'AWSSDK.Extensions.NETCore.Setup',
  ],
};
