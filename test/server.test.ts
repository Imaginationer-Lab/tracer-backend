import { gzipSync } from 'node:zlib';
import { pack } from 'tar-stream';
import { describe, expect, it } from 'vitest';
import { MAX_SOURCE_BYTES } from '../src/engine/files.js';
import { RateLimiter } from '../src/server/analyses/rate-limiter.js';
import { loadConfig, type AppConfig } from '../src/server/config.js';
import { isOriginAllowed } from '../src/server/cors.js';
import { parseDemoEvent } from '../src/server/demo/demo.controller.js';
import { ApiException } from '../src/server/errors.js';
import { parseRepoUrl } from '../src/server/github/github.client.js';
import { extractRepoFiles } from '../src/server/github/tarball.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as ApiException).code;
  }
  return null;
};

describe('parseRepoUrl', () => {
  it('공개 GitHub 저장소 URL을 받는다', () => {
    expect(parseRepoUrl('  https://github.com/acme/demo-store  ')).toEqual({ owner: 'acme', name: 'demo-store' });
    expect(parseRepoUrl('https://github.com/acme/demo-store.git')).toEqual({ owner: 'acme', name: 'demo-store' });
    expect(parseRepoUrl('https://github.com/acme/demo-store/tree/main/src')).toEqual({ owner: 'acme', name: 'demo-store' });
  });

  it('형식이 다르면 INVALID_REPO_URL', () => {
    for (const bad of ['github.com/acme', 'http://github.com/acme/x', 'https://gitlab.com/acme/x', 'https://github.com/acme', 'https://github.com/acme/..', 42, undefined]) {
      expect(code(() => parseRepoUrl(bad))).toBe('INVALID_REPO_URL');
    }
  });
});

describe('RateLimiter', () => {
  const cfg = { rateLimit: { burst: 3, refillSeconds: 60 } } as AppConfig;

  it('한 번에 3개까지, 이후 60초마다 1개', () => {
    const limiter = new RateLimiter(cfg);
    const t0 = 1_000_000;
    expect([1, 2, 3].map(() => limiter.take('1.2.3.4', t0).ok)).toEqual([true, true, true]);
    expect(limiter.take('1.2.3.4', t0)).toEqual({ ok: false, retryAfter: 60 });
    expect(limiter.take('1.2.3.4', t0 + 30_000)).toEqual({ ok: false, retryAfter: 30 });
    expect(limiter.take('1.2.3.4', t0 + 60_000).ok).toBe(true);
    // 다른 IP는 따로 센다
    expect(limiter.take('5.6.7.8', t0).ok).toBe(true);
    limiter.onModuleDestroy();
  });
});

describe('CORS', () => {
  it('기본값은 프론트(localhost:9100)만 허용', () => {
    const { corsOrigins } = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(corsOrigins).toEqual(['http://localhost:9100', 'http://127.0.0.1:9100']);
    expect(isOriginAllowed('http://localhost:9100', corsOrigins)).toBe(true);
    expect(isOriginAllowed('http://localhost:3000', corsOrigins)).toBe(false);
    expect(isOriginAllowed('https://evil.example', corsOrigins)).toBe(false);
  });

  it('Origin이 없는 요청(curl, Postman, 헬스체크)은 통과', () => {
    expect(isOriginAllowed(undefined, ['http://localhost:9100'])).toBe(true);
  });

  it('CORS_ORIGINS로 바꿀 수 있고, 형식이 틀리면 시작하지 않는다', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://x', CORS_ORIGINS: 'https://outage.example.com/, http://localhost:9100' }).corsOrigins).toEqual([
      'https://outage.example.com',
      'http://localhost:9100',
    ]);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', CORS_ORIGINS: 'localhost:9100' })).toThrow(/CORS_ORIGINS/);
  });
});

describe('parseDemoEvent', () => {
  it('올바른 이벤트', () => {
    expect(parseDemoEvent('{"providerId":"stripe","title":"Stripe 결제 API 응답 실패","httpStatus":503,"occurredAt":"2026-11-25T10:00:00+09:00"}')).toEqual({
      providerId: 'stripe',
      title: 'Stripe 결제 API 응답 실패',
      httpStatus: 503,
      occurredAt: '2026-11-25T01:00:00.000Z',
    });
  });

  it('형식이 틀리면 DEMO_EVENT_INVALID', () => {
    for (const bad of ['not json', '{}', '{"providerId":"paypal","title":"x","httpStatus":503,"occurredAt":"2026-11-25T01:00:00Z"}', '{"providerId":"stripe","title":"x","httpStatus":999,"occurredAt":"2026-11-25T01:00:00Z"}']) {
      expect(code(() => parseDemoEvent(bad))).toBe('DEMO_EVENT_INVALID');
    }
  });
});

describe('extractRepoFiles', () => {
  const tarball = async (entries: { name: string; content?: string; type?: 'file' | 'symlink'; linkname?: string }[]) => {
    const p = pack();
    for (const e of entries) {
      if (e.type === 'symlink') p.entry({ name: e.name, type: 'symlink', linkname: e.linkname! });
      else p.entry({ name: e.name }, e.content ?? '');
    }
    p.finalize();
    const chunks: Buffer[] = [];
    for await (const c of p) chunks.push(c as Buffer);
    return gzipSync(Buffer.concat(chunks));
  };
  const limits = { maxFiles: 100, maxBytes: 10 * 1024 * 1024 };

  it('일반 파일만 읽고, 심볼릭 링크·상위 경로·무시 폴더는 버린다', async () => {
    const files = await extractRepoFiles(
      await tarball([
        { name: 'acme-demo-abc123/src/a.ts', content: "import Stripe from 'stripe';" },
        { name: 'acme-demo-abc123/README.md', content: '# demo' },
        { name: 'acme-demo-abc123/node_modules/x/index.js', content: 'x' },
        { name: 'acme-demo-abc123/secret', type: 'symlink', linkname: '/etc/passwd' },
        { name: 'acme-demo-abc123/../evil.ts', content: 'evil' },
      ]),
      limits,
    );
    expect(files).toEqual([
      { path: 'src/a.ts', content: "import Stripe from 'stripe';" },
      { path: 'README.md', content: '' },
    ]);
  });

  it('큰 파일은 앞부분만 남겨서 엔진이 too-large로 건너뛰게 한다', async () => {
    const big = 'x'.repeat(MAX_SOURCE_BYTES + 200_000);
    const [file] = await extractRepoFiles(await tarball([{ name: 'r/src/big.js', content: big }]), limits);
    expect(file!.content.length).toBeGreaterThan(MAX_SOURCE_BYTES);
    expect(file!.content.length).toBeLessThan(big.length);
  });

  it('파일 수 상한을 넘으면 REPO_TOO_LARGE', async () => {
    const t = await tarball([{ name: 'r/a.ts', content: 'a' }, { name: 'r/b.ts', content: 'b' }]);
    await expect(extractRepoFiles(t, { ...limits, maxFiles: 1 })).rejects.toMatchObject({ code: 'REPO_TOO_LARGE' });
  });
});
