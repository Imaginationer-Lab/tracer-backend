import { describe, expect, it } from 'vitest';
import { toAnalysisResult, toProviderDetail } from '../src/api/present.js';
import { analyze } from '../src/engine/analyze.js';
import type { EngineResult, Evidence, ProviderId } from '../src/engine/types.js';
import { detect, fixtureFiles, type Detection } from './detect.js';

const cache = new Map<string, Promise<Detection>>();
const detection = (name: string) => {
  if (!cache.has(name)) cache.set(name, detect(fixtureFiles(name)));
  return cache.get(name)!;
};
const run = async (name: string) => (await detection(name)).r;
const result = async (name: string) => {
  const d = await detection(name);
  return toAnalysisResult(d.r, d.dir);
};
const detail = async (name: string, id: ProviderId) => {
  const d = await detection(name);
  return toProviderDetail(d.r, id, d.dir);
};

const at = (r: EngineResult, provider: ProviderId, path: string): Evidence[] => r.evidence.filter((e) => e.provider === provider && e.path === path);
const lines = (es: Evidence[], kind?: Evidence['kind']) => es.filter((e) => !kind || e.kind === kind).map((e) => e.line);

describe('TS 쇼핑몰 (디자인 예제)', () => {
  it('판정한 서비스를 모두 내고, 디자인의 세 서비스가 먼저 나온다', async () => {
    const providers = (await result('ts-shop')).providers;
    expect(providers.slice(0, 3).map((p) => [p.id, p.role, p.category, p.usage])).toEqual([
      ['supabase', '로그인', 'auth', 'used'],
      ['stripe', '결제', 'payment', 'used'],
      ['aws-s3', '파일 업로드', 'storage', 'used'],
    ]);
    // 나머지: 배송 파트너(호스트 + 주소를 못 푼 호출), Twilio는 의존성만
    expect(providers.slice(3).map((p) => [p.id, p.name, p.category, p.usage])).toEqual([
      ['shipping-partner', 'Shipping Partner API', 'other', 'used'],
      ['twilio', 'Twilio', 'messaging', 'declared-only'],
    ]);
    expect(providers.filter((p) => p.statusSupport === 'live').map((p) => p.id)).toEqual(['supabase']);
  });

  it('checkout.ts:2 를 api.stripe.com 호출로 짚고, 재시도·타임아웃·상태 처리가 없다고 본다', async () => {
    const r = await run('ts-shop');
    const http = at(r, 'stripe', 'src/payments/checkout.ts').find((e) => e.kind === 'http')!;
    expect(http).toMatchObject({ line: 2, detail: 'api.stripe.com' });
    expect(http.facts).toEqual({ errorHandling: false, retry: false, timeout: false, statusCheck: false });

    // 기능정의서 공통 형식: providers[].files[].path, line
    const stripe = (await result('ts-shop')).providers.find((p) => p.id === 'stripe')!;
    expect(stripe.files).toContainEqual({ path: 'src/payments/checkout.ts', line: 2 });
    expect(stripe.fileCount).toBe(stripe.files.length);

    const ev = (await detail('ts-shop', 'stripe')).evidence.find((e) => e.path === 'src/payments/checkout.ts')!;
    expect(ev.reason.label).toBe('api.stripe.com 호출');
    expect(ev.endpoint).toEqual({ host: 'api.stripe.com', path: '/v1/checkout/sessions' });
    expect(ev.snippet.startLine).toBe(1);
    expect(ev.snippet.lines[1]).toContain("fetch('https://api.stripe.com/v1/checkout/sessions'");
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

  it('대표 줄은 클라이언트 생성(new S3Client)이 아니라 실제 호출(s3.send)', async () => {
    const r = await run('ts-shop');
    expect(lines(at(r, 'aws-s3', 'src/storage/upload.ts'), 'call')).toEqual(expect.arrayContaining([3, 7]));
    expect((await result('ts-shop')).providers.find((p) => p.id === 'aws-s3')!.files).toContainEqual({ path: 'src/storage/upload.ts', line: 7 });
    const ev = (await detail('ts-shop', 'aws-s3')).evidence.find((e) => e.path === 'src/storage/upload.ts')!;
    expect([ev.line, ev.reason.label]).toEqual([7, 's3.send 호출']);
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

  it('1차 분석(규칙 없음)은 후보만 모은다: 의존성, 선언 없이 import한 패키지, 호스트, 주소를 못 푼 호출', async () => {
    const { candidates } = await detection('ts-shop');
    expect(candidates.evidence).toEqual([]);
    expect(candidates.ambiguous).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'host', host: 'api.shipping-partner.kr' }),
        expect.objectContaining({ kind: 'host', host: 'api.stripe.com' }),
        expect.objectContaining({ kind: 'http', hint: '설정 SHIPPING_API_URL (값 없음)' }),
        expect.objectContaining({ kind: 'dependency', name: 'stripe' }),
        expect.objectContaining({ kind: 'dependency', name: 'twilio' }),
        // package.json에는 없고 Svelte 파일에서 import
        expect.objectContaining({ kind: 'dependency', name: '@supabase/supabase-js' }),
      ]),
    );
    // 자기 서버 호출(/api/orders)과 흔한 라이브러리(react, axios)는 후보가 아니다
    expect(candidates.ambiguous.some((a) => a.kind === 'http' && a.call.includes('/api/orders'))).toBe(false);
    expect(candidates.ambiguous.some((a) => a.kind === 'dependency' && ['react', 'axios', 'next'].includes(a.name))).toBe(false);
  });

  it('판정으로 이번 분석의 규칙을 만들고, 규칙으로 못 만드는 판정(주소를 못 푼 호출)은 그 위치에 붙인다', async () => {
    const { plan, r } = await detection('ts-shop');
    expect(plan.rules.length).toBeGreaterThan(0);
    expect(plan.rules.every((x) => x.source === 'learned' && x.id.startsWith('ai:'))).toBe(true);
    expect(plan.direct).toEqual([expect.objectContaining({ provider: 'shipping-partner' })]);
    expect(r.evidence.some((e) => e.provider === 'shipping-partner' && e.kind === 'llm')).toBe(true);
  });

  it('사전 필터는 파싱할 파일을 줄이면서 결과는 그대로다', async () => {
    const { files, plan } = await detection('ts-shop');
    const filtered = await analyze(files, { rules: plan.rules });
    const full = await analyze(files, { rules: plan.rules, prefilter: false });
    const key = (e: Evidence) => `${e.provider}|${e.path}|${e.line}|${e.kind}`;
    expect(filtered.evidence.map(key).sort()).toEqual(full.evidence.map(key).sort());
    expect(filtered.stats.parsedFiles).toBeLessThan(full.stats.parsedFiles);
  });
});

describe('Python FastAPI', () => {
  it('stripe SDK, boto3(AWS 전체 SDK), httpx + 환경변수 Supabase', async () => {
    const r = await run('py-fastapi');
    expect(lines(at(r, 'stripe', 'app/services/payments.py'), 'call')).toContain(9);
    // boto3는 AWS 전체 SDK라 판정이 'aws'다 (S3만 따로 가르는 규칙은 없앰)
    expect(lines(at(r, 'aws', 'app/services/storage.py'), 'call')).toEqual(expect.arrayContaining([3, 7]));
    const auth = at(r, 'supabase', 'app/services/auth.py').find((e) => e.kind === 'http')!;
    expect(auth).toMatchObject({ line: 10, role: '로그인' });
    expect(auth.facts).toMatchObject({ timeout: true, statusCheck: true });
  });

  it('1-hop: from app.services import payments 로 main.py 호출을 잇는다', async () => {
    const r = await run('py-fastapi');
    expect(lines(at(r, 'stripe', 'app/main.py'), 'call')).toContain(10);
  });

  it('.env.example 값으로 주소를 풀고, 모르는 host 와 의존성은 후보로', async () => {
    const r = (await detection('py-fastapi')).candidates;
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
    const r = (await detection('java-spring')).candidates;
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
    expect((await detection('dotnet-api')).candidates.ambiguous.some((a) => a.kind === 'dependency' && a.name === 'SendGrid')).toBe(true);
  });
});
