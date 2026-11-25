import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze.js';
import { clueKey, parseJudgments, rulesFromJudgments, type Verdict } from '../src/engine/learn.js';
import type { AmbiguousItem } from '../src/engine/types.js';
import run from '../src/engine/worker.js';
import { judgeClues, type JudgeDeps } from '../src/server/llm/clue-classifier.js';
import { fixtureFiles, fixtureJudge } from './detect.js';

const files = fixtureFiles('py-fastapi');

/** 메모리 DB + 고정 판정을 JSON으로 답하는 가짜 모델 */
function fakeDeps(store = new Map<string, Verdict>()) {
  const calls: string[] = [];
  const deps: JudgeDeps = {
    lookup: async (keys) => new Map(keys.flatMap((k) => (store.has(k) ? [[k, store.get(k)!] as const] : []))),
    save: async (rows) => rows.forEach((r) => store.set(r.key, r.verdict)),
    complete: async (_system, user) => {
      calls.push(user);
      const items = (JSON.parse(user) as { items: { id: string }[] }).items;
      const { ambiguous } = await analyze(files);
      const byId = new Map(ambiguous.map((a) => [a.id, a]));
      return { text: `판정입니다.\n${JSON.stringify(fixtureJudge(items.map((i) => byId.get(i.id)!)))}`, usage: { input: 10, output: 5 } };
    },
    model: 'test-model',
    maxItems: 600,
  };
  return { deps, calls, store };
}

describe('AI 판정 (judgeClues)', () => {
  it('처음 보는 후보만 묻고, 판정을 저장해 다음 저장소에서는 다시 묻지 않는다', async () => {
    const { ambiguous } = await analyze(files);
    const { deps, calls, store } = fakeDeps();

    const first = await judgeClues(ambiguous, deps);
    expect([first.asked, first.cached, first.unanswered, calls.length]).toEqual([ambiguous.length, 0, 0, 1]);
    expect(store.size).toBe(ambiguous.length);

    const second = await judgeClues(ambiguous, deps);
    expect([second.asked, second.cached, calls.length]).toEqual([0, ambiguous.length, 1]);
    expect(second.judgments).toEqual(expect.arrayContaining(first.judgments));
  });

  it('많으면 나눠서 묻는다', async () => {
    const { ambiguous } = await analyze(files);
    const { deps, calls } = fakeDeps();
    await judgeClues(ambiguous, { ...deps, batch: 2 });
    expect(calls.length).toBe(Math.ceil(ambiguous.length / 2));
  });

  it('경로·줄 번호는 보내지 않는다', async () => {
    const { ambiguous } = await analyze(files);
    const { deps, calls } = fakeDeps();
    await judgeClues(ambiguous, deps);
    expect(calls[0]).not.toContain('app/api/shipping.py');
    expect(calls[0]).not.toContain('occurrences');
  });

  it('AI 키가 없으면 저장된 판정만 쓰고, 처음 보는 후보가 있으면 DETECTION_UNAVAILABLE', async () => {
    const { ambiguous } = await analyze(files);
    const { deps, store } = fakeDeps();
    const { complete: _c, ...noAi } = deps;
    await expect(judgeClues(ambiguous, noAi)).rejects.toMatchObject({ code: 'DETECTION_UNAVAILABLE' });
    await judgeClues(ambiguous, deps);
    expect((await judgeClues(ambiguous, noAi)).cached).toBe(store.size);
  });

  it('같은 단서는 저장소가 달라도 같은 키 (버전이 붙는다)', () => {
    const a: AmbiguousItem = { id: 'u1', kind: 'host', host: 'API.Shipping-Partner.kr', occurrences: [{ path: 'a.py', line: 1 }] };
    const b: AmbiguousItem = { id: 'u7', kind: 'host', host: 'api.shipping-partner.kr', occurrences: [{ path: 'b.ts', line: 9 }] };
    expect(clueKey(a)).toBe(clueKey(b));
    expect(clueKey(a)).toMatch(/^v\d+\|host\|/);
  });
});

describe('답 검증 (parseJudgments)', () => {
  const items: AmbiguousItem[] = [
    { id: 'd1', kind: 'dependency', ecosystem: 'nuget', name: 'AWSSDK.S3', occurrences: [{ path: 'a.csproj', line: 3 }] },
    { id: 'u1', kind: 'host', host: 'api.tosspayments.com', occurrences: [{ path: 'toss.ts', line: 2 }] },
    { id: 'd2', kind: 'dependency', ecosystem: 'npm', name: 'lodash-es', occurrences: [{ path: 'package.json', line: 5 }] },
  ];

  it('알려진 서비스 별칭은 고정 id로 맞추고, 분류·역할을 검증한다', () => {
    const out = parseJudgments(
      JSON.stringify([
        { id: 'd1', verdict: 'service', service: { id: 'amazon-s3', name: 'Amazon S3', category: 'storage', role: '파일 업로드' }, imports: ['Amazon.S3'], types: ['IAmazonS3', 'bad type!'] },
        { id: 'u1', verdict: 'service', service: { id: 'Toss Payments', name: 'Toss Payments', category: 'fintech', role: '결제' }, keywords: ['toss', 'api'] },
        { id: 'd2', verdict: 'library' },
      ]),
      items,
    );
    expect(out).toEqual([
      { id: 'd1', verdict: 'service', service: { id: 'aws-s3', name: 'Amazon S3', category: 'storage', role: '파일 업로드' }, imports: ['Amazon.S3'], types: ['IAmazonS3'] },
      // 모르는 분류는 other, 이름에서 id를 만든다, 흔한 단어 키워드는 버린다
      { id: 'u1', verdict: 'service', service: { id: 'toss-payments', name: 'Toss Payments', category: 'other', role: '결제' }, keywords: ['toss'] },
      { id: 'd2', verdict: 'library' },
    ]);
  });

  it('없는 후보 id, 모르는 판정, 이름 없는 서비스, 깨진 JSON은 버린다', () => {
    expect(parseJudgments('not json', items)).toEqual([]);
    expect(
      parseJudgments(
        JSON.stringify([
          { id: 'zzz', verdict: 'library' },
          { id: 'd1', verdict: 'maybe' },
          { id: 'u1', verdict: 'service', service: { id: 'x' } },
          'junk',
        ]),
        items,
      ),
    ).toEqual([]);
  });
});

describe('판정 → 규칙 → 결과', () => {
  it('너무 넓은 패턴은 규칙으로 만들지 않는다', () => {
    const items: AmbiguousItem[] = [{ id: 'd1', kind: 'dependency', ecosystem: 'maven', name: 'com.acme:sdk', occurrences: [{ path: 'pom.xml', line: 9 }] }];
    const plan = rulesFromJudgments(items, [
      { id: 'd1', verdict: 'service', service: { id: 'acme', name: 'Acme', category: 'other', role: '외부 API' }, imports: ['a'], types: ['*Ab'] },
    ]);
    // dependency 규칙은 남고, 'a'·'*Ab' 같은 넓은 import·type 패턴은 버린다
    expect(plan.rules.map((r) => r.match.type)).toEqual(['dependency']);
    expect(plan.services).toEqual([{ id: 'acme', name: 'Acme', category: 'other', role: '외부 API', statusPageUrl: null }]);
  });

  it('워커가 판정 결과로 서비스 목록·근거를 만든다 (otherServices는 항상 [])', async () => {
    const { ambiguous } = await analyze(files);
    const plan = rulesFromJudgments(ambiguous, fixtureJudge(ambiguous));
    const out = await run({ files, rules: plan.rules, services: plan.services, direct: plan.direct });
    expect(out.result.otherServices).toEqual([]);
    expect(out.result.providers.map((p) => p.id)).toEqual(['supabase', 'stripe', 'aws', 'sendgrid', 'shipping-partner']);
    expect(out.result.providers.find((p) => p.id === 'sendgrid')).toMatchObject({ name: 'SendGrid', category: 'messaging', role: '메일 발송' });
    expect(Object.keys(out.details).sort()).toEqual(out.result.providers.map((p) => p.id).sort());
  });

  it('판정이 없으면 서비스도 없다', async () => {
    const out = await run({ files });
    expect(out.result.providers).toEqual([]);
  });
});
