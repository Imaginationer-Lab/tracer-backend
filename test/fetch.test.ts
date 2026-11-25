import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { pack } from 'tar-stream';
import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../src/api/contract.js';
import { analyze } from '../src/engine/analyze.js';
import { MAX_SOURCE_BYTES } from '../src/engine/files.js';
import { blobQuery, fetchBlobs, type GraphQL } from '../src/server/github/blobs.js';
import { planFetch, type TreeEntry } from '../src/server/github/repo-plan.js';
import { extractRepoFiles } from '../src/server/github/tarball.js';
import { ApiException } from '../src/server/errors.js';

const blob = (path: string, size = 100, mode = '100644'): TreeEntry => ({ path, mode, type: 'blob', size });
const limits = { maxFiles: 100, maxFetchBytes: 10 * 1024 * 1024 };

describe('planFetch (트리만 보고 받을 파일 고르기)', () => {
  it('소스·매니페스트·설정만 받고, 나머지는 경로만, 무시 폴더·링크·서브모듈은 뺀다', () => {
    const plan = planFetch(
      [
        blob('src/pay.ts'),
        blob('package.json'),
        blob('.env.example'),
        blob('README.md'),
        blob('assets/demo.gif', 18_000_000),
        blob('.yarn/cache/next-swc.zip', 43_000_000),
        blob('node_modules/x/index.js'),
        blob('src/link.ts', 10, '120000'),
        { path: 'vendor-sub', mode: '160000', type: 'commit' },
        { path: 'src', mode: '040000', type: 'tree' },
      ],
      limits,
    );
    expect(plan.fetch.map((f) => f.path)).toEqual(['src/pay.ts', 'package.json', '.env.example']);
    expect(plan.listed).toEqual([
      { path: 'README.md', content: '' },
      { path: 'assets/demo.gif', content: '' },
      { path: '.yarn/cache/next-swc.zip', content: '' },
    ]);
    expect(plan.fetchBytes).toBe(300);
    // tarball을 받으면 받게 될 크기 (무시 폴더 포함)
    expect(plan.totalBytes).toBe(100 * 4 + 18_000_000 + 43_000_000 + 100 + 10);
  });

  it('512KB가 넘는 소스는 받지 않고 too-large로 넘긴다', () => {
    const plan = planFetch([blob('src/huge.ts', MAX_SOURCE_BYTES + 1)], limits);
    expect(plan.fetch).toEqual([]);
    expect(plan.listed).toEqual([{ path: 'src/huge.ts', content: '', tooLarge: true }]);
  });

  it('파일 수나 읽을 크기가 한도를 넘으면 REPO_TOO_LARGE (이미지·캐시 크기는 세지 않음)', () => {
    const many = Array.from({ length: 101 }, (_, i) => blob(`src/f${i}.ts`));
    expect(() => planFetch(many, limits)).toThrow(ApiException);
    expect(() => planFetch([blob('a.ts', 300_000), blob('b.ts', 300_000)], { ...limits, maxFetchBytes: 500_000 })).toThrow(ApiException);
    expect(() => planFetch([blob('a.ts'), blob('big.mp4', 900_000_000)], limits)).not.toThrow();
  });
});

describe('fetchBlobs (필요한 파일만 GraphQL로)', () => {
  const repo: RepoRef = { owner: 'acme', name: 'shop', branch: 'main', commit: 'c'.repeat(40) };
  /** 쿼리의 별칭과 expression을 읽어 경로마다 내용을 돌려주는 가짜 GraphQL */
  const fake = (contents: Record<string, string | null>, log: string[] = []): GraphQL => async (query) => {
    log.push(query);
    const repository: Record<string, { text: string | null } | null> = {};
    for (const m of query.matchAll(/(f\d+): object\(expression: ("(?:[^"\\]|\\.)*")\)/g)) {
      const path = (JSON.parse(m[2]!) as string).split(':').slice(1).join(':');
      repository[m[1]!] = path in contents ? { text: contents[path]! } : null;
    }
    return { data: { repository } };
  };

  it('묶음으로 나눠 보내고, 순서대로 경로와 내용을 돌려준다', async () => {
    const paths = Array.from({ length: 7 }, (_, i) => `src/f${i}.ts`);
    const log: string[] = [];
    const files = await fetchBlobs(repo, paths, fake(Object.fromEntries(paths.map((p) => [p, `// ${p}`])), log), { batch: 3, concurrency: 2 });
    expect(log).toHaveLength(3);
    expect(files).toEqual(paths.map((p) => ({ path: p, content: `// ${p}` })));
  });

  it('바이너리(text null)나 없는 경로는 빈 내용', async () => {
    const files = await fetchBlobs(repo, ['a.ts', 'b.ts'], fake({ 'a.ts': null }));
    expect(files).toEqual([
      { path: 'a.ts', content: '' },
      { path: 'b.ts', content: '' },
    ]);
  });

  it('특수문자 경로도 쿼리에 안전하게 들어간다', () => {
    const q = blobQuery(repo, ['src/"quoted"\\name.ts']);
    expect(q).toContain(JSON.stringify(`${repo.commit}:src/"quoted"\\name.ts`));
  });

  it('GraphQL 한도면 GITHUB_RATE_LIMITED, 일시 오류는 한 번 더 시도한다', async () => {
    await expect(fetchBlobs(repo, ['a.ts'], async () => ({ errors: [{ type: 'RATE_LIMITED' }] }))).rejects.toMatchObject({ code: 'GITHUB_RATE_LIMITED' });
    let calls = 0;
    const flaky: GraphQL = async (q) => (++calls === 1 ? { errors: [{ message: 'timeout' }] } : fake({ 'a.ts': 'ok' })(q));
    expect(await fetchBlobs(repo, ['a.ts'], flaky)).toEqual([{ path: 'a.ts', content: 'ok' }]);
    expect(calls).toBe(2);
  });

  it('저장소가 안 보이면 REPO_NOT_ACCESSIBLE', async () => {
    await expect(fetchBlobs(repo, ['a.ts'], async () => ({ data: { repository: null } }))).rejects.toMatchObject({ code: 'REPO_NOT_ACCESSIBLE' });
  });
});

describe('받은 파일을 엔진에 넘기기', () => {
  it('too-large로 넘긴 소스는 skipped too-large', async () => {
    const r = await analyze([
      { path: 'src/huge.ts', content: '', tooLarge: true },
      { path: 'src/pay.ts', content: "import Stripe from 'stripe';\nconst s = new Stripe(process.env.STRIPE_KEY!);\ns.charges.create({});" },
    ]);
    expect(r.files.find((f) => f.path === 'src/huge.ts')).toMatchObject({ state: 'skipped', reason: 'too-large' });
    expect(r.files.find((f) => f.path === 'src/pay.ts')).toMatchObject({ state: 'analyzed' });
    expect(r.ambiguous.some((a) => a.kind === 'dependency' && a.name === 'stripe')).toBe(true);
  });

  it('tarball을 스트림으로 받아 풀고, 받는 도중 오류는 그대로 올린다', async () => {
    const p = pack();
    p.entry({ name: 'r/src/a.ts' }, "import Stripe from 'stripe';");
    p.finalize();
    const chunks: Buffer[] = [];
    for await (const c of p) chunks.push(c as Buffer);
    const gz = gzipSync(Buffer.concat(chunks));
    const lim = { maxFiles: 10, maxBytes: 1024 * 1024 };

    expect(await extractRepoFiles(Readable.from([gz.subarray(0, 10), gz.subarray(10)]), lim)).toEqual([{ path: 'src/a.ts', content: "import Stripe from 'stripe';" }]);

    const broken = new Readable({ read() {} });
    broken.push(gz.subarray(0, 10));
    setTimeout(() => broken.destroy(new ApiException('REPO_TOO_LARGE')), 5);
    await expect(extractRepoFiles(broken, lim)).rejects.toMatchObject({ code: 'REPO_TOO_LARGE' });
  });
});
