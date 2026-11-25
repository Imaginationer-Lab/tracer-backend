import { createHash } from 'node:crypto';
import type { Ecosystem, Lang, ProviderCategory, ProviderId } from './types.js';

// ─── 규칙 스키마 ──────────────────────────────────────────────────────────────
// 내장 규칙은 없다. 규칙은 분석할 때마다 AI 판정(learn.ts)에서 만들어지는 데이터다:
//   "이 의존성·호스트는 Stripe다" → dependency·import·host 규칙 → 엔진이 줄 번호·호출 추적·코드 사실을 찾는다.
// 엔진은 규칙을 해석만 하고 실행하지 않는다. 모든 문자열 패턴은 '*' 글롭이다 (glob.ts).

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
/** 서비스 id 모양 (URL 경로에 그대로 쓴다) */
export const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** DB나 LLM에서 온 규칙을 받기 전에 모양을 검사한다. 너무 넓은 패턴도 여기서 거른다. */
export function validateRule(value: unknown): { ok: true; rule: Rule } | { ok: false; error: string } {
  const r = value as Partial<Rule> | null;
  if (!r || typeof r !== 'object') return { ok: false, error: 'not an object' };
  if (typeof r.id !== 'string' || !/^[\w:.\-/@*]{1,120}$/.test(r.id)) return { ok: false, error: 'bad id' };
  if (typeof r.provider !== 'string' || !SERVICE_ID.test(r.provider)) return { ok: false, error: 'bad provider id' };
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

// ─── 서비스 정보 ────────────────────────────────────────────────────────────

export interface ServiceInfo {
  id: ProviderId;
  name: string;
  category: ProviderCategory;
  /** 화면용 한국어 라벨 */
  role: string;
  statusPageUrl: string | null;
  /** 공개 상태 API (Statuspage 형식). 없으면 "실시간 연동 전" */
  statusApi?: string;
  /** 근거의 호출식·URL 경로로 역할을 더 좁힌다 (알려진 서비스만) */
  roles?: { callee?: string; path?: string; role: string }[];
}

export const CATEGORIES: ProviderCategory[] = ['auth', 'payment', 'storage', 'database', 'ai', 'messaging', 'monitoring', 'analytics', 'other'];

/** 역할을 좁혔을 때 분류도 따라 바꾼다 (Supabase 데이터베이스 → 로그인이면 auth) */
const ROLE_CATEGORY: Record<string, ProviderCategory> = { 로그인: 'auth', 결제: 'payment', '파일 업로드': 'storage', '파일 저장': 'storage', 데이터베이스: 'database' };

export function categoryOf(service: ServiceInfo, role: string): ProviderCategory {
  return role === service.role ? service.category : (ROLE_CATEGORY[role] ?? service.category);
}

/**
 * 디자인·상태 연동이 있는 서비스. AI 판정이 이 서비스면 id·이름·상태 API를 여기 값으로 맞춘다.
 * 탐지 규칙이 아니다 (탐지는 AI가 한다).
 */
export const KNOWN_SERVICES: Record<string, ServiceInfo & { aliases: string[] }> = {
  supabase: {
    id: 'supabase',
    name: 'Supabase',
    category: 'database',
    role: '데이터베이스',
    statusPageUrl: 'https://status.supabase.com',
    statusApi: 'https://status.supabase.com/api/v2/status.json',
    roles: [
      { callee: '*.auth.*', role: '로그인' },
      { path: '/auth/*', role: '로그인' },
      { callee: '*.storage.*', role: '파일 저장' },
      { path: '/storage/*', role: '파일 저장' },
    ],
    aliases: ['supabase'],
  },
  stripe: { id: 'stripe', name: 'Stripe', category: 'payment', role: '결제', statusPageUrl: 'https://status.stripe.com', aliases: ['stripe'] },
  'aws-s3': {
    id: 'aws-s3',
    name: 'Amazon S3',
    category: 'storage',
    role: '파일 업로드',
    statusPageUrl: 'https://health.aws.amazon.com/health/status',
    aliases: ['aws-s3', 'amazon-s3', 's3', 'amazon-simple-storage-service'],
  },
};

/** 화면 순서: 디자인의 세 서비스가 먼저 */
export const FEATURED_ORDER = ['supabase', 'stripe', 'aws-s3'];

/** 엔진 로직(추출·해석)을 바꿔서 같은 규칙으로도 결과가 달라지면 올린다. 분석 캐시 키에 들어간다. */
export const ENGINE_VERSION = 6;

export function rulesetVersion(rules: Rule[]): string {
  const payload = JSON.stringify([ENGINE_VERSION, rules.map((r) => [r.id, r.provider, r.langs, r.match])]);
  return createHash('sha1').update(payload).digest('hex').slice(0, 10);
}

// ─── 공급자가 아닌 의존성 ───────────────────────────────────────────────────
// AI에 "이건 어떤 서비스냐"고 물을 필요가 없는 흔한 라이브러리(외부 서비스를 부르지 않음). 비용을 줄이는 거름망이고, 여기서 빠진 것만 후보가 된다.

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
    'pytest*', 'black', 'ruff', 'mypy', 'isort', 'flake8', 'numpy', 'pandas', 'passlib*', 'python-jose*',
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
