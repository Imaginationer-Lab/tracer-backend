import { describe, expect, it } from 'vitest';
import { classifyStatus, HostProber, probeHost, type ProbeDeps } from '../src/server/providers/host-probe.js';
import { hostTargets } from '../src/api/present.js';
import { discoverOne, parseCandidates } from '../src/server/providers/status-registry.js';
import { builtinStatus } from '../src/server/providers/status-sources.js';
import { isPublicAddress, readStatus, verifyStatusPage, type VerifyDeps } from '../src/server/providers/status-verify.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const statusBody = { page: { name: 'Acme', url: 'https://status.acme.io' }, status: { indicator: 'none', description: 'All Systems Operational' } };

/** host → 주소, url → 응답 */
const fakeDeps = (dns: Record<string, string[]>, routes: Record<string, () => Response>): VerifyDeps & { fetched: string[] } => {
  const fetched: string[] = [];
  return {
    fetched,
    resolve: async (host) => {
      if (!dns[host]) throw new Error('ENOTFOUND');
      return dns[host]!;
    },
    fetch: async (url) => {
      fetched.push(url);
      const r = routes[url];
      if (!r) throw new Error('no route');
      return r();
    },
  };
};

describe('상태 API 목록', () => {
  it('서비스 id가 같거나 "id-"로 시작하면 맞는다', () => {
    expect(builtinStatus('toss-payments')?.apiUrl).toBe('https://status.tosspayments.com/api/v2/status.json');
    expect(builtinStatus('notion-api')?.pageUrl).toBe('https://www.notion-status.com');
    expect(builtinStatus('anthropic-claude')?.pageUrl).toBe('https://status.claude.com');
    expect(builtinStatus('supabase')).not.toBeNull();
    // 앞부분만 같은 다른 서비스는 아니다
    expect(builtinStatus('azure-openai')).toBeNull();
    expect(builtinStatus('stripe')).toBeNull();
    expect(builtinStatus('githubber')).toBeNull();
  });
});

describe('상태 페이지 검증 (AI가 찾아 온 주소)', () => {
  it('공개 주소인지', () => {
    for (const ok of ['104.16.1.1', '2606:4700::1']) expect(isPublicAddress(ok)).toBe(true);
    for (const bad of ['127.0.0.1', '10.0.0.5', '172.20.1.1', '192.168.0.1', '169.254.169.254', '100.82.108.102', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPublicAddress(bad), bad).toBe(false);
    }
  });

  it('Statuspage 모양이면 통과하고, 페이지 주소는 응답의 page.url', async () => {
    const deps = fakeDeps({ 'status.acme.io': ['104.16.1.1'] }, { 'https://status.acme.io/api/v2/status.json': () => json(statusBody) });
    expect(await verifyStatusPage('https://status.acme.io/history?x=1', deps)).toEqual({ pageUrl: 'https://status.acme.io', apiUrl: 'https://status.acme.io/api/v2/status.json' });
  });

  it('http, IP 주소, 사설 주소로 풀리는 도메인, 내부 도메인은 부르지도 않는다', async () => {
    const deps = fakeDeps({ 'evil.example': ['10.0.0.5'], 'status.acme.io': ['104.16.1.1'] }, {});
    for (const c of ['http://status.acme.io', 'https://104.16.1.1', 'https://evil.example', 'https://metadata.internal', 'https://status.acme.io:8443', 'https://u:p@status.acme.io']) {
      expect(await verifyStatusPage(c, deps), c).toBeNull();
    }
    expect(deps.fetched).toEqual([]);
  });

  it('리다이렉트는 같은 경로로만, 도착한 곳도 다시 검사한다', async () => {
    const redirect = (to: string) => () => new Response(null, { status: 301, headers: { location: to } });
    const ok = fakeDeps(
      { 'status.sendgrid.com': ['104.16.1.1'], 'status.twilio.com': ['104.16.1.2'] },
      { 'https://status.sendgrid.com/api/v2/status.json': redirect('https://status.twilio.com/api/v2/status.json'), 'https://status.twilio.com/api/v2/status.json': () => json(statusBody) },
    );
    expect((await readStatus('https://status.sendgrid.com/api/v2/status.json', ok))?.apiUrl).toBe('https://status.twilio.com/api/v2/status.json');

    const toPrivate = fakeDeps({ 'status.acme.io': ['104.16.1.1'], 'inside.acme.io': ['192.168.0.10'] }, { 'https://status.acme.io/api/v2/status.json': redirect('https://inside.acme.io/api/v2/status.json') });
    expect(await readStatus('https://status.acme.io/api/v2/status.json', toPrivate)).toBeNull();
    expect(toPrivate.fetched).toEqual(['https://status.acme.io/api/v2/status.json']);

    const otherPath = fakeDeps({ 'status.acme.io': ['104.16.1.1'] }, { 'https://status.acme.io/api/v2/status.json': redirect('/admin') });
    expect(await readStatus('https://status.acme.io/api/v2/status.json', otherPath)).toBeNull();
  });

  it('모양이 다르거나 JSON이 아니면 실패', async () => {
    for (const body of [{ page: { name: 'x' } }, { page: { name: 'x' }, status: { indicator: 'weird', description: '' } }]) {
      const deps = fakeDeps({ 'status.acme.io': ['104.16.1.1'] }, { 'https://status.acme.io/api/v2/status.json': () => json(body) });
      expect(await verifyStatusPage('https://status.acme.io', deps)).toBeNull();
    }
    const html = fakeDeps({ 'status.acme.io': ['104.16.1.1'] }, { 'https://status.acme.io/api/v2/status.json': () => new Response('<html>') });
    expect(await verifyStatusPage('https://status.acme.io', html)).toBeNull();
  });
});

describe('처음 보는 서비스 상태 페이지 찾기', () => {
  it('AI 답에서 https 주소만 꺼낸다', () => {
    expect(parseCandidates('찾았어요 {"candidates":["https://status.acme.io","http://x.io","javascript:alert(1)",3]}')).toEqual(['https://status.acme.io']);
    expect(parseCandidates('없음')).toEqual([]);
  });

  it('후보를 차례로 확인해 처음 통과한 것을 저장하고, 못 찾아도 저장한다', async () => {
    const saved: unknown[] = [];
    const verify = async (c: string) => (c === 'https://status.acme.io' ? { pageUrl: c, apiUrl: `${c}/api/v2/status.json` } : null);
    const save = async (row: unknown) => void saved.push(row);
    const found = await discoverOne({ id: 'acme', name: 'Acme' }, { find: async () => ['https://www.acme.io', 'https://status.acme.io'], verify, save });
    expect(found?.pageUrl).toBe('https://status.acme.io');
    await discoverOne({ id: 'nostatus', name: 'No Status' }, { find: async () => [], verify, save });
    expect(saved).toEqual([
      { id: 'acme', name: 'Acme', source: { pageUrl: 'https://status.acme.io', apiUrl: 'https://status.acme.io/api/v2/status.json' } },
      { id: 'nostatus', name: 'No Status', source: null },
    ]);
  });
});

describe('호스트별 응답 확인', () => {
  const probeDeps = (dns: Record<string, string[]>, answer: Record<string, number | 'down'>): ProbeDeps & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      resolve: async (host) => {
        if (!dns[host]) throw new Error('ENOTFOUND');
        return dns[host]!;
      },
      request: async (url) => {
        asked.push(url);
        const a = answer[url];
        if (a === undefined || a === 'down') throw new Error('timeout');
        return a;
      },
    };
  };
  const BASE = 'https://www.google.com/generate_204';

  it('상태 코드 판정: 403·429를 뺀 4xx는 살아 있음, 403·429는 확인 불가', () => {
    for (const s of [200, 204, 301, 307, 400, 401, 404, 405, 421]) expect(classifyStatus(s), String(s)).toBe('ok');
    for (const s of [500, 502, 503]) expect(classifyStatus(s), String(s)).toBe('error');
    for (const s of [403, 429, 100, 600]) expect(classifyStatus(s), String(s)).toBe('unknown');
  });

  it('호스트 루트에만, 응답이 없으면 외부 기준 주소로 우리 쪽 문제인지 가린다', async () => {
    const d = probeDeps({ 'api.stripe.com': ['104.16.1.1'], 'down.acme.io': ['104.16.1.2'] }, { 'https://api.stripe.com/': 401, [BASE]: 204 });
    expect(await probeHost('api.stripe.com', d)).toMatchObject({ result: 'ok', label: '응답 있음', httpStatus: 401 });
    expect(await probeHost('down.acme.io', d)).toMatchObject({ result: 'error', label: '응답 이상', httpStatus: null });
    expect(d.asked).toEqual(['https://api.stripe.com/', 'https://down.acme.io/', BASE]);

    const offline = probeDeps({ 'down.acme.io': ['104.16.1.2'] }, {});
    expect(await probeHost('down.acme.io', offline)).toMatchObject({ result: 'unknown', label: '확인 불가' });
  });

  it('내부 주소로 풀리거나 이상한 호스트는 부르지 않는다', async () => {
    const d = probeDeps({ 'evil.example': ['10.0.0.5'] }, {});
    for (const h of ['evil.example', 'localhost', '127.0.0.1', 'metadata.internal', 'nowhere.example', 'a.com:8443', 'u@a.com', 'a.com/x']) {
      expect((await probeHost(h, d)).result, h).toBe('unknown');
    }
    expect(d.asked).toEqual([]);
  });

  it('같은 호스트는 60초 동안 한 번만', async () => {
    const d = probeDeps({ 'api.stripe.com': ['104.16.1.1'] }, { 'https://api.stripe.com/': 401 });
    const prober = new HostProber();
    prober.deps = d;
    const target = { name: 'api', host: 'api.stripe.com', files: [] };
    const [a, b] = await Promise.all([prober.hosts([target]), prober.hosts([target])]);
    await prober.hosts([target]);
    expect(d.asked).toEqual(['https://api.stripe.com/']);
    expect(a[0]).toMatchObject({ name: 'api', host: 'api.stripe.com', probe: { result: 'ok' }, files: [] });
    expect(b).toEqual(a);
  });

  it('서비스당 최대 3개, 부르는 파일이 많은 순', () => {
    const info = { id: 'openai', name: 'OpenAI', category: 'ai' as const, role: 'AI', statusPageUrl: null };
    const uses = ['a', 'b', 'c', 'd'].flatMap((h, i) => Array.from({ length: 4 - i }, (_, j) => ({ host: `${h}.openai.com`, path: `f${j}.ts`, line: 1 })));
    expect(hostTargets([...uses, { host: '*.openai.com', path: 'x.ts', line: 1 }], info).map((t) => t.host)).toEqual(['a.openai.com', 'b.openai.com', 'c.openai.com']);
  });
});
