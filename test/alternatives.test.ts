import { describe, expect, it } from 'vitest';
import type { EvidenceItem } from '../src/api/contract.js';
import { CATEGORIES } from '../src/engine/rules.js';
import { altKey, buildAltInput, loadSkill, parseAltPlan, presentAlternatives, skillMessage, useGroups } from '../src/server/alternatives/alternatives.js';

const ev = (path: string, line: number, label: string, code: string, endpoint: EvidenceItem['endpoint'] = null): EvidenceItem => ({
  path,
  line,
  language: 'typescript',
  reason: { kind: endpoint ? 'http' : 'call', label },
  snippet: { startLine: line, lines: [code] },
  facts: null,
  endpoint,
});

const stripe = [
  ev('src/payments/checkout.ts', 2, 'api.stripe.com 호출', "fetch('https://api.stripe.com/v1/checkout/sessions')", { host: 'api.stripe.com', path: '/v1/checkout/sessions' }),
  ev('src/payments/refund.ts', 4, 'stripe.refunds.create 호출', 'stripe.refunds.create({ payment_intent })'),
];
const service = { id: 'stripe', name: 'Stripe', category: 'payment' as const, role: '결제' };
const repoServices = [{ id: 'toss-payments', name: 'Toss Payments', category: 'payment' as const }];

describe('대체 서비스 스킬', () => {
  it('SKILL.md와 분류마다 참고 문서가 있고, 그 분류 문서만 넣는다', () => {
    const skill = loadSkill();
    expect(skill.instructions.startsWith('# 대체 서비스 고르기')).toBe(true);
    for (const c of CATEGORIES) expect(skill.references[c], c).toBeTruthy();
    const msg = skillMessage(skill, buildAltInput({ id: 'aws-s3', name: 'Amazon S3', category: 'storage', role: '파일 업로드' }, useGroups(stripe), []));
    expect(msg).toContain('S3 호환');
    expect(msg).not.toContain('OpenAI 호환');
  });
});

describe('대체 서비스', () => {
  it('AI 입력에는 파일 경로가 없어서, 같은 코드면 저장소가 달라도 키가 같다', () => {
    const a = buildAltInput(service, useGroups(stripe), repoServices);
    const moved = stripe.map((e) => ({ ...e, path: `app/${e.path}` }));
    expect(JSON.stringify(a)).not.toContain('src/payments');
    expect(altKey(buildAltInput(service, useGroups(moved), repoServices), 'm', 's')).toBe(altKey(a, 'm', 's'));
    // 저장소에 있는 같은 분류 서비스가 다르면 다른 키 (in-repo가 달라진다)
    expect(altKey(buildAltInput(service, useGroups(stripe), []), 'm', 's')).not.toBe(altKey(a, 'm', 's'));
    // 스킬 문서가 바뀌면 다시 만든다
    expect(altKey(a, 'm', 's2')).not.toBe(altKey(a, 'm', 's'));
  });

  it('같은 호출은 한 묶음, 파일은 모두 모은다', () => {
    const twice = [...stripe, { ...stripe[0]!, path: 'src/payments/again.ts' }];
    const groups = useGroups(twice);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.files.map((f) => f.path)).toEqual(['src/payments/checkout.ts', 'src/payments/again.ts']);
  });

  it('AI 답은 안전 검사만 하고 순서는 그대로 둔다', () => {
    const groups = useGroups(stripe);
    const input = buildAltInput(service, groups, repoServices);
    const answer = JSON.stringify({
      features: [
        { key: 'checkout-session', label: '결제창 생성', uses: [0] },
        { key: 'refund', label: '환불', uses: [1, 99] },
        { key: 'BAD KEY', label: 'x', uses: [0] },
      ],
      alternatives: [
        { id: 'paddle', name: 'Paddle', category: 'payment', fit: 'drop-in', summary: '요청 형식이 다르다', coverage: [{ feature: 'checkout-session', support: 'yes' }, { feature: 'refund', support: 'partial', note: '부분 환불만' }], settings: ['STRIPE_SECRET_KEY', 'rm -rf /;'], editUses: [0, 1] },
        { id: 'toss-payments', name: 'Toss Payments', category: 'payment', fit: 'in-repo', summary: '이미 연동됨', coverage: [{ feature: 'checkout-session', support: 'yes' }, { feature: 'refund', support: 'yes' }], settings: [], editUses: [0] },
        // 자기 자신, 형식이 틀린 id, 없는 분류는 뺀다

        { id: 'stripe', name: 'Stripe', category: 'payment', fit: 'drop-in', coverage: [{ feature: 'checkout-session', support: 'yes' }] },
        { id: 'Bad Id', name: 'x', category: 'payment', coverage: [] },
        { id: 'weird', name: 'x', category: 'banking', coverage: [{ feature: 'refund', support: 'yes' }] },
      ],
    });
    const plan = parseAltPlan(`좋아요 ${answer}`, input)!;
    expect(plan.features.map((f) => [f.key, f.uses])).toEqual([['checkout-session', [0]], ['refund', [1]]]);
    expect(plan.alternatives.map((a) => [a.id, a.fit])).toEqual([['paddle', 'drop-in'], ['toss-payments', 'in-repo']]);
    expect(plan.alternatives[0]!.settings).toEqual(['STRIPE_SECRET_KEY']);

    const out = presentAlternatives(plan, groups, (id) => (id === 'toss-payments' ? 'live' : 'none'));
    expect(out.features[1]).toEqual({ key: 'refund', label: '환불', files: [{ path: 'src/payments/refund.ts', line: 4 }] });
    expect(out.alternatives[1]).toMatchObject({ fitLabel: '저장소에 이미 있음', statusSupport: 'live', changes: { settings: [], files: [{ path: 'src/payments/checkout.ts', line: 2 }] } });
    expect(out.alternatives[0]!.coverage[1]).toEqual({ feature: 'refund', support: 'partial', note: '부분 환불만' });
  });

  it('in-repo라고 했지만 저장소에 없으면 rewrite, 별칭은 알려진 id로', () => {
    const input = buildAltInput({ id: 'cloudinary', name: 'Cloudinary', category: 'storage', role: '파일 저장' }, useGroups(stripe), []);
    const plan = parseAltPlan(
      JSON.stringify({
        features: [{ key: 'upload', label: '업로드', uses: [0] }],
        alternatives: [
          { id: 'imgix', name: 'imgix', category: 'storage', fit: 'in-repo', coverage: [{ feature: 'upload', support: 'yes' }] },
          { id: 's3', name: 'Amazon S3', category: 'storage', fit: 'rewrite', coverage: [{ feature: 'upload', support: 'yes' }] },
        ],
      }),
      input,
    )!;
    expect(plan.alternatives.map((a) => [a.id, a.fit])).toEqual([['imgix', 'rewrite'], ['aws-s3', 'rewrite']]);
  });

  it('모양이 다르면 null', () => {
    const input = buildAltInput(service, useGroups(stripe), []);
    for (const t of ['없음', '{"features":[]}', '{"features":[{"key":"a","label":"a","uses":[]}],"alternatives":[]}']) expect(parseAltPlan(t, input), t).toBeNull();
    expect(parseAltPlan('{"features":[{"key":"a","label":"a","uses":[0]}],"alternatives":[]}', input)?.alternatives).toEqual([]);
  });
});
