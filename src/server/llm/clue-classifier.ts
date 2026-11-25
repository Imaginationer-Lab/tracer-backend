// 규칙으로 못 푼 단서(모르는 host, 의존성, 주소를 못 푼 HTTP 호출)를 Claude로 분류한다.
//   1) 단서 키로 clue_classifications를 먼저 본다. 저장소가 달라도 같은 단서는 다시 묻지 않는다.
//   2) 처음 보는 단서만 한 번에 모아 보낸다. 파일 경로·줄 번호·코드 전문은 보내지 않는다 (learn.ts).
//   3) 답은 스키마 검증(parseClassifications)을 통과한 것만 쓰고 저장한다.
// 실패하거나 시간이 넘으면 규칙 결과만으로 분석을 끝낸다 (AI 판단은 덤).

import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { buildClassificationInput, clueKey, CLASSIFY_SYSTEM, parseClassifications, type Classification } from '../../engine/learn.js';
import type { AmbiguousItem } from '../../engine/types.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { AnalysisRepository, type StoredClassification } from '../db/analysis.repository.js';

/** system, user → 모델이 쓴 텍스트 */
export type Complete = (system: string, user: string) => Promise<{ text: string; usage?: { input: number; output: number } }>;

export interface ClassifyDeps {
  lookup: (keys: string[]) => Promise<Map<string, StoredClassification>>;
  save: (rows: (StoredClassification & { key: string; kind: AmbiguousItem['kind']; model: string })[]) => Promise<void>;
  complete: Complete;
  model: string;
  maxItems: number;
}

export interface ClassifyOutcome {
  classifications: Classification[];
  cached: number;
  asked: number;
  usage?: { input: number; output: number };
}

const toClassification = (id: string, s: StoredClassification): Classification =>
  s.provider === 'other' ? { id, provider: 'other', service: s.service ?? 'unknown' } : { id, provider: s.provider as Exclude<Classification['provider'], 'other'> };

/** DB·모델을 바꿔 끼울 수 있게 분리한 본체 (테스트는 이것만 부른다) */
export async function classifyClues(items: AmbiguousItem[], deps: ClassifyDeps): Promise<ClassifyOutcome> {
  const keyed = items.map((item) => ({ item, key: clueKey(item) }));
  const stored = await deps.lookup([...new Set(keyed.map((k) => k.key))]);
  const classifications: Classification[] = [];
  const fresh: typeof keyed = [];
  for (const k of keyed) {
    const s = stored.get(k.key);
    if (s) classifications.push(toClassification(k.item.id, s));
    else fresh.push(k);
  }
  if (!fresh.length) return { classifications, cached: classifications.length, asked: 0 };

  // 너무 많으면 여러 곳에서 쓰인 단서부터 보낸다
  const ask = [...fresh].sort((a, b) => b.item.occurrences.length - a.item.occurrences.length).slice(0, deps.maxItems);
  const { text, usage } = await deps.complete(CLASSIFY_SYSTEM, buildClassificationInput(ask.map((k) => k.item)));
  const answered = parseClassifications(
    text,
    ask.map((k) => k.item),
  );
  const keyById = new Map(ask.map((k) => [k.item.id, k]));
  await deps.save(
    answered.map((c) => {
      const k = keyById.get(c.id)!;
      return { key: k.key, kind: k.item.kind, provider: c.provider, service: c.provider === 'other' ? c.service : null, model: deps.model };
    }),
  );
  return { classifications: [...classifications, ...answered], cached: classifications.length, asked: ask.length, ...(usage ? { usage } : {}) };
}

@Injectable()
export class ClueClassifier {
  private readonly logger = new Logger('ClueClassifier');
  private readonly client: Anthropic | null;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly repo: AnalysisRepository,
  ) {
    this.client = cfg.llm ? new Anthropic({ apiKey: cfg.llm.apiKey, timeout: cfg.llm.timeoutMs, maxRetries: 1 }) : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /** 분석 캐시 키에 붙인다. AI를 켜거나 모델을 바꾸면 같은 커밋도 다시 분석한다 */
  get versionTag(): string {
    return this.cfg.llm ? `+llm:${this.cfg.llm.model}` : '';
  }

  /** 실패하면 빈 배열 (규칙 결과만 쓴다) */
  async classify(items: AmbiguousItem[]): Promise<Classification[]> {
    if (!this.client || !this.cfg.llm || !items.length) return [];
    const { model, maxItems } = this.cfg.llm;
    const t0 = Date.now();
    try {
      const out = await classifyClues(items, {
        lookup: (keys) => this.repo.findClassifications(keys),
        save: (rows) => this.repo.saveClassifications(rows),
        complete: (system, user) => this.complete(system, user),
        model,
        maxItems,
      });
      const tokens = out.usage ? `, 토큰 입력 ${out.usage.input} · 출력 ${out.usage.output}` : '';
      this.logger.log(`단서 ${items.length}개: 저장된 판정 ${out.cached}개, 새로 물음 ${out.asked}개 (${Date.now() - t0}ms${tokens})`);
      return out.classifications;
    } catch (err) {
      const reason = err instanceof Anthropic.APIError ? `API ${err.status ?? '-'} ${err.name}` : err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI 분류 실패, 규칙 결과만 사용: ${reason}`);
      return [];
    }
  }

  private async complete(system: string, user: string): Promise<{ text: string; usage: { input: number; output: number } }> {
    const res = await this.client!.messages.create({
      model: this.cfg.llm!.model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
      // 단서 이름을 서비스로 옮기는 분류라 깊게 생각할 필요가 없다. 응답 속도를 우선한다
      output_config: { effort: 'low' },
    });
    if (res.stop_reason === 'refusal') throw new Error('model refused');
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return { text, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens } };
  }
}
