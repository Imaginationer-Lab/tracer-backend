import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analyze.js';
import { clueKey, type Classification } from '../src/engine/learn.js';
import { loadRepoFromDir } from '../src/engine/load.js';
import type { AmbiguousItem } from '../src/engine/types.js';
import run from '../src/engine/worker.js';
import type { StoredClassification } from '../src/server/db/analysis.repository.js';
import { classifyClues, type ClassifyDeps } from '../src/server/llm/clue-classifier.js';

const dir = new URL('./fixtures/py-fastapi', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const files = loadRepoFromDir(dir);

/** 메모리 DB + 정해진 답을 하는 모델 */
function fakeDeps(answer: (items: { id: string }[]) => unknown[], store = new Map<string, StoredClassification>()) {
  const calls: string[] = [];
  const deps: ClassifyDeps = {
    lookup: async (keys) => new Map(keys.flatMap((k) => (store.has(k) ? [[k, store.get(k)!] as const] : []))),
    save: async (rows) => rows.forEach((r) => store.set(r.key, { provider: r.provider, service: r.service })),
    complete: async (_system, user) => {
      calls.push(user);
      return { text: `판정 결과입니다.\n${JSON.stringify(answer(JSON.parse(user).items))}` };
    },
    model: 'test-model',
    maxItems: 300,
  };
  return { deps, calls, store };
}

const smart = (items: { id: string }[]) =>
  items.map((i) => (i.id.startsWith('u') ? { id: i.id, provider: 'other', service: 'Shipping Partner API' } : { id: i.id, provider: 'other', service: 'SendGrid' }));

describe('AI 단서 분류', () => {
  it('처음 보는 단서만 묻고, 판정을 저장해 다음 저장소에서는 다시 묻지 않는다', async () => {
    const { ambiguous } = await analyze(files);
    const { deps, calls, store } = fakeDeps(smart);

    const first = await classifyClues(ambiguous, deps);
    expect([first.asked, first.cached, calls.length]).toEqual([ambiguous.length, 0, 1]);
    expect(store.size).toBe(ambiguous.length);

    const second = await classifyClues(ambiguous, deps);
    expect([second.asked, second.cached, calls.length]).toEqual([0, ambiguous.length, 1]);
    expect(second.classifications).toEqual(expect.arrayContaining(first.classifications));
  });

  it('경로·줄 번호는 보내지 않는다', async () => {
    const { ambiguous } = await analyze(files);
    const { deps, calls } = fakeDeps(smart);
    await classifyClues(ambiguous, deps);
    expect(calls[0]).not.toContain('app/api/shipping.py');
    expect(calls[0]).not.toContain('occurrences');
  });

  it('형식이 틀리거나 없는 id·공급자를 지어낸 답은 버린다', async () => {
    const { ambiguous } = await analyze(files);
    const { deps, store } = fakeDeps(() => [{ id: 'zzz', provider: 'stripe' }, { id: ambiguous[0]!.id, provider: 'paypal' }, 'junk']);
    const out = await classifyClues(ambiguous, deps);
    expect(out.classifications).toEqual([]);
    expect(store.size).toBe(0);
  });

  it('같은 단서는 저장소가 달라도 같은 키', () => {
    const a: AmbiguousItem = { id: 'u1', kind: 'host', host: 'API.Shipping-Partner.kr', occurrences: [{ path: 'a.py', line: 1 }] };
    const b: AmbiguousItem = { id: 'u7', kind: 'host', host: 'api.shipping-partner.kr', occurrences: [{ path: 'b.ts', line: 9 }] };
    expect(clueKey(a)).toBe(clueKey(b));
  });
});

describe('판정을 결과에 반영', () => {
  it('기타 서비스로 모으고 파일·줄을 붙인다', async () => {
    const { ambiguous } = await analyze(files);
    const classifications = smart(ambiguous) as Classification[];
    const out = await run({ files, classifications });
    expect(out.result.otherServices.map((o) => o.name).sort()).toEqual(['SendGrid', 'Shipping Partner API']);
    const shipping = out.result.otherServices.find((o) => o.name === 'Shipping Partner API')!;
    expect(shipping.clues).toEqual(['api.shipping-partner.kr']);
    expect(shipping.files).toContainEqual({ path: 'app/api/shipping.py', line: 9 });
    expect(shipping.fileCount).toBe(new Set(shipping.files.map((f) => f.path)).size);
  });

  it('공급자로 판정되면 AI 판단 근거로 들어간다', async () => {
    const { ambiguous } = await analyze(files);
    const host = ambiguous.find((a) => a.kind === 'host')!;
    const out = await run({ files, classifications: [{ id: host.id, provider: 'supabase' }] });
    const ev = out.details.supabase!.evidence.find((e) => e.path === 'app/api/shipping.py');
    expect(ev?.reason).toEqual({ kind: 'llm', label: 'AI 판단 · api.shipping-partner.kr' });
  });

  it('판정이 없으면 기타 서비스는 빈 배열', async () => {
    const out = await run({ files });
    expect(out.result.otherServices).toEqual([]);
  });
});
