import { describe, expect, it } from 'vitest';
import { toAnalysisResult, toProviderDetail } from '../src/api/present.js';
import { analyze } from '../src/engine/analyze.js';
import { loadRepoFromDir } from '../src/engine/load.js';
import type { EngineResult, Evidence, ProviderId } from '../src/engine/types.js';

const fixture = (name: string) => loadRepoFromDir(new URL(`./fixtures/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const cache = new Map<string, Promise<EngineResult>>();
const run = (name: string) => {
  if (!cache.has(name)) cache.set(name, analyze(fixture(name)));
  return cache.get(name)!;
};

const at = (r: EngineResult, provider: ProviderId, path: string): Evidence[] => r.evidence.filter((e) => e.provider === provider && e.path === path);
const lines = (es: Evidence[], kind?: Evidence['kind']) => es.filter((e) => !kind || e.kind === kind).map((e) => e.line);

describe('TS 쇼핑몰 (디자인 예제)', () => {
  it('세 공급자를 찾고 역할을 붙인다', async () => {
    const result = toAnalysisResult(await run('ts-shop'));
    expect(result.providers.map((p) => [p.id, p.role, p.usage])).toEqual([
      ['supabase', '로그인', 'used'],
      ['stripe', '결제', 'used'],
      ['aws-s3', '파일 업로드', 'used'],
    ]);
  });

  it('checkout.ts:2 를 api.stripe.com 호출로 짚고, 재시도·타임아웃·상태 처리가 없다고 본다', async () => {
    const r = await run('ts-shop');
    const http = at(r, 'stripe', 'src/payments/checkout.ts').find((e) => e.kind === 'http')!;
    expect(http).toMatchObject({ line: 2, detail: 'api.stripe.com' });
    expect(http.facts).toEqual({ errorHandling: false, retry: false, timeout: false, statusCheck: false });

    const detail = toProviderDetail(r, 'stripe').evidence.find((e) => e.path === 'src/payments/checkout.ts')!;
    expect(detail.reason.label).toBe('api.stripe.com 호출');
    expect(detail.snippet.startLine).toBe(1);
    expect(detail.snippet.lines[1]).toContain("fetch('https://api.stripe.com/v1/checkout/sessions'");
  });

  it('동적 서브도메인 *.supabase.co 도 Supabase 로그인으로 본다', async () => {
    const r = await run('ts-shop');
    const http = at(r, 'supabase', 'src/auth/login.ts').find((e) => e.kind === 'http')!;
    expect(http).toMatchObject({ line: 2, detail: '*.supabase.co', role: '로그인' });
  });

  it('1-hop: SDK 이름이 없는 refund.ts 도 래퍼 모듈을 거쳐 Stripe 호출로 잡는다', async () => {
    const r = await run('ts-shop');
    expect(lines(at(r, 'stripe', 'src/payments/refund.ts'), 'call')).toContain(4);
  });

  it('S3 클라이언트 변수 추적과 try 안 호출', async () => {
    const r = await run('ts-shop');
    const send = at(r, 'aws-s3', 'src/storage/upload.ts').find((e) => e.kind === 'call' && e.line === 7)!;
    expect(send.facts?.errorHandling).toBe(true);
  });

  it('Svelte <script> 와 SvelteKit $env 도 읽는다', async () => {
    const r = await run('ts-shop');
    const es = at(r, 'supabase', 'src/routes/+page.svelte');
    expect(lines(es, 'setting')).toContain(2);
    expect(es.find((e) => e.kind === 'call' && e.line === 6)?.role).toBe('로그인');
  });

  it('축소 번들은 건너뛰고, node_modules 는 목록에 없고, 테스트 파일은 분석하지 않는다', async () => {
    const r = await run('ts-shop');
    const byPath = new Map(r.files.map((f) => [f.path, f]));
    expect(byPath.get('src/legacy/bundle.min.js')).toMatchObject({ state: 'skipped', reason: 'minified' });
    expect([...byPath.keys()].some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(byPath.get('src/payments/checkout.test.ts')?.state).toBe('other');
    expect(byPath.get('README.md')?.state).toBe('other');
  });

  it('규칙으로 못 푼 것만 애매 후보로 남긴다', async () => {
    const r = await run('ts-shop');
    expect(r.ambiguous).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'host', host: 'api.shipping-partner.kr' }),
        expect.objectContaining({ kind: 'http', hint: '설정 SHIPPING_API_URL (값 없음)' }),
        expect.objectContaining({ kind: 'dependency', name: 'twilio' }),
      ]),
    );
    // 자기 서버 호출(/api/orders)과 흔한 라이브러리(react, axios)는 후보가 아니다
    expect(r.ambiguous.some((a) => a.kind === 'http' && a.call.includes('/api/orders'))).toBe(false);
    expect(r.ambiguous.some((a) => a.kind === 'dependency' && ['react', 'axios'].includes(a.name))).toBe(false);
  });

  it('사전 필터는 파싱할 파일을 줄이면서 결과는 그대로다', async () => {
    const files = fixture('ts-shop');
    const filtered = await run('ts-shop');
    const full = await analyze(files, { prefilter: false });
    const key = (e: Evidence) => `${e.provider}|${e.path}|${e.line}|${e.kind}`;
    expect(filtered.evidence.map(key).sort()).toEqual(full.evidence.map(key).sort());
    expect(filtered.stats.parsedFiles).toBeLessThan(full.stats.parsedFiles);
  });
});

describe('Python FastAPI', () => {
  it('stripe SDK, boto3 S3, httpx + 환경변수 Supabase', async () => {
    const r = await run('py-fastapi');
    expect(lines(at(r, 'stripe', 'app/services/payments.py'), 'call')).toContain(9);
    expect(lines(at(r, 'aws-s3', 'app/services/storage.py'), 'call')).toEqual(expect.arrayContaining([3, 7]));
    const auth = at(r, 'supabase', 'app/services/auth.py').find((e) => e.kind === 'http')!;
    expect(auth).toMatchObject({ line: 10, role: '로그인' });
    expect(auth.facts).toMatchObject({ timeout: true, statusCheck: true });
  });

  it('1-hop: from app.services import payments 로 main.py 호출을 잇는다', async () => {
    const r = await run('py-fastapi');
    expect(lines(at(r, 'stripe', 'app/main.py'), 'call')).toContain(10);
  });

  it('.env.example 값으로 주소를 풀고, 모르는 host 와 의존성은 후보로', async () => {
    const r = await run('py-fastapi');
    const host = r.ambiguous.find((a) => a.kind === 'host' && a.host === 'api.shipping-partner.kr');
    expect(host?.occurrences).toEqual(expect.arrayContaining([{ path: 'app/api/shipping.py', line: 9 }]));
    expect(r.ambiguous.some((a) => a.kind === 'dependency' && a.name === 'sendgrid')).toBe(true);
  });
});

describe('Java Spring', () => {
  it('import 한 Stripe 클래스 호출과 주입된 S3Client', async () => {
    const r = await run('java-spring');
    expect(lines(at(r, 'stripe', 'src/main/java/com/acme/pay/PaymentService.java'), 'call')).toContain(15);
    const s3 = at(r, 'aws-s3', 'src/main/java/com/acme/storage/StorageService.java');
    expect(lines(s3, 'type')).toContain(10);
    expect(lines(s3, 'call')).toContain(17);
  });

  it('@Value 설정 키를 거친 RestTemplate 호출을 Supabase 로그인으로', async () => {
    const r = await run('java-spring');
    const http = at(r, 'supabase', 'src/main/java/com/acme/auth/SupabaseAuthClient.java').find((e) => e.kind === 'http')!;
    expect(http).toMatchObject({ line: 19, role: '로그인' });
    expect(http.facts?.errorHandling).toBe(true);
  });

  it('1-hop: 주입된 PaymentService 를 쓰는 컨트롤러', async () => {
    const r = await run('java-spring');
    expect(lines(at(r, 'stripe', 'src/main/java/com/acme/web/CheckoutController.java'), 'call')).toContain(18);
  });

  it('@FeignClient 주소를 application.yml 기본값까지 따라간다', async () => {
    const r = await run('java-spring');
    const host = r.ambiguous.find((a) => a.kind === 'host' && a.host === 'api.shipping-partner.kr');
    expect(host?.occurrences).toEqual(expect.arrayContaining([{ path: 'src/main/java/com/acme/shipping/ShippingClient.java', line: 6 }]));
    expect(r.ambiguous.some((a) => a.kind === 'dependency' && a.name === 'com.acme:legacy-erp-client')).toBe(true);
  });
});

describe('.NET', () => {
  it('using Stripe 뒤 Service 클래스와 주입된 IAmazonS3', async () => {
    const r = await run('dotnet-api');
    expect(lines(at(r, 'stripe', 'Services/PaymentService.cs'), 'call')).toEqual(expect.arrayContaining([9, 10]));
    const s3 = at(r, 'aws-s3', 'Services/StorageService.cs');
    expect(lines(s3, 'type')).toContain(8);
    expect(lines(s3, 'call')).toContain(16);
  });

  it('IConfiguration 키를 거친 HttpClient 호출을 Supabase 로그인으로', async () => {
    const r = await run('dotnet-api');
    const http = at(r, 'supabase', 'Services/AuthClient.cs').find((e) => e.kind === 'http')!;
    expect(http).toMatchObject({ line: 18, role: '로그인' });
    expect(http.facts?.statusCheck).toBe(true);
  });

  it('appsettings.json 주석을 건너뛰고 값을 읽는다', async () => {
    const r = await run('dotnet-api');
    expect(at(r, 'supabase', 'appsettings.json').some((e) => e.kind === 'config')).toBe(true);
    expect(r.ambiguous.some((a) => a.kind === 'dependency' && a.name === 'SendGrid')).toBe(true);
  });
});
