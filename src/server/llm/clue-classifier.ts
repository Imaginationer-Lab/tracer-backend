// 엔진이 모은 후보(의존성, 호스트, 주소를 못 푼 HTTP 호출)가 어떤 외부 서비스인지 Claude로 판정한다.
//   1) 단서 키로 clue_classifications를 먼저 본다. 저장소가 달라도 같은 단서는 다시 묻지 않는다.
//   2) 처음 보는 단서만 묶어서 보낸다 (150개씩, 동시에 4개). 파일 경로·줄 번호·코드 전문은 보내지 않는다 (learn.ts).
//   3) 답은 검증(parseJudgments)을 통과한 것만 쓰고 저장한다.
// 판정이 탐지의 전부라서, 처음 보는 단서를 판정하지 못하면 분석을 DETECTION_UNAVAILABLE로 실패시킨다
// ("탐지 결과 없음"으로 잘못 보이지 않게). 실패한 분석은 캐시하지 않아서 다시 요청하면 다시 시도한다.

import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { buildClassificationInput, clueKey, CLASSIFY_SYSTEM, CLUE_VERSION, parseJudgments, type Judgment, type Verdict } from '../../engine/learn.js';
import type { AmbiguousItem } from '../../engine/types.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { AnalysisRepository } from '../db/analysis.repository.js';
import { ApiException } from '../errors.js';

/** system, user → 모델이 쓴 텍스트 */
export type Complete = (system: string, user: string) => Promise<{ text: string; usage?: { input: number; output: number } }>;

export interface JudgeDeps {
  lookup: (keys: string[]) => Promise<Map<string, Verdict>>;
  save: (rows: { key: string; kind: AmbiguousItem['kind']; verdict: Verdict; model: string }[]) => Promise<void>;
  /** 없으면 처음 보는 단서를 판정할 수 없다 (AI 키 없음) */
  complete?: Complete;
  model: string;
  maxItems: number;
  batch?: number;
  concurrency?: number;
}

export interface JudgeOutcome {
  judgments: Judgment[];
  cached: number;
  asked: number;
  /** 물었지만 답이 없거나 검증에서 버린 후보 수 */
  unanswered: number;
  usage: { input: number; output: number };
}

/** DB·모델을 바꿔 끼울 수 있게 분리한 본체 (테스트는 이것만 부른다) */
export async function judgeClues(items: AmbiguousItem[], deps: JudgeDeps): Promise<JudgeOutcome> {
  const keyed = items.map((item) => ({ item, key: clueKey(item) }));
  const stored = await deps.lookup([...new Set(keyed.map((k) => k.key))]);
  const judgments: Judgment[] = [];
  const fresh: typeof keyed = [];
  for (const k of keyed) {
    const v = stored.get(k.key);
    if (v) judgments.push({ ...v, id: k.item.id });
    else fresh.push(k);
  }
  const usage = { input: 0, output: 0 };
  if (!fresh.length) return { judgments, cached: judgments.length, asked: 0, unanswered: 0, usage };
  if (!deps.complete) throw new ApiException('DETECTION_UNAVAILABLE');

  // 너무 많으면 여러 곳에서 쓰인 단서부터
  const ask = [...fresh].sort((a, b) => b.item.occurrences.length - a.item.occurrences.length).slice(0, deps.maxItems);
  const size = deps.batch ?? 150;
  const batches: (typeof ask)[] = [];
  for (let i = 0; i < ask.length; i += size) batches.push(ask.slice(i, i + size));

  const answered: Judgment[] = [];
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++]!;
      const res = await deps.complete!(CLASSIFY_SYSTEM, buildClassificationInput(batch.map((k) => k.item)));
      if (res.usage) (usage.input += res.usage.input), (usage.output += res.usage.output);
      answered.push(
        ...parseJudgments(
          res.text,
          batch.map((k) => k.item),
        ),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? 4, batches.length) }, worker));

  const keyById = new Map(ask.map((k) => [k.item.id, k]));
  await deps.save(
    answered.map(({ id, ...verdict }) => {
      const k = keyById.get(id)!;
      return { key: k.key, kind: k.item.kind, verdict, model: deps.model };
    }),
  );
  return { judgments: [...judgments, ...answered], cached: judgments.length, asked: ask.length, unanswered: ask.length - answered.length, usage };
}

@Injectable()
export class ClueClassifier {
  private readonly logger = new Logger('ClueClassifier');
  private readonly client: Anthropic | null;
  /** 테스트용 고정 판정 (CLUE_FIXTURE_FILE). 단서 키(버전 접두어 없이) → 판정 */
  private readonly fixture: Record<string, Verdict> | null;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly repo: AnalysisRepository,
  ) {
    this.client = cfg.llm ? new Anthropic({ apiKey: cfg.llm.apiKey, timeout: cfg.llm.timeoutMs, maxRetries: 1 }) : null;
    this.fixture = cfg.clueFixtureFile ? (JSON.parse(readFileSync(cfg.clueFixtureFile, 'utf8')) as Record<string, Verdict>) : null;
  }

  /** 분석 캐시 키에 붙인다. 판정 방식(모델·프롬프트 버전)이 바뀌면 같은 커밋도 다시 분석한다 */
  get versionTag(): string {
    if (this.fixture) return `+fixture`;
    return `+ai:${this.cfg.llm?.model ?? 'none'}:v${CLUE_VERSION}`;
  }

  /** 처음 보는 단서를 판정하지 못하면 DETECTION_UNAVAILABLE */
  async judge(items: AmbiguousItem[]): Promise<Judgment[]> {
    if (!items.length) return [];
    if (this.fixture) {
      const prefix = `v${CLUE_VERSION}|`;
      return items.map((i) => ({ ...(this.fixture![clueKey(i).slice(prefix.length)] ?? { verdict: 'unknown' as const }), id: i.id }));
    }
    const model = this.cfg.llm?.model ?? 'none';
    const t0 = Date.now();
    try {
      const out = await judgeClues(items, {
        lookup: (keys) => this.repo.findJudgments(keys),
        save: (rows) => this.repo.saveJudgments(rows),
        ...(this.client ? { complete: (system: string, user: string) => this.complete(system, user) } : {}),
        model,
        maxItems: this.cfg.llm?.maxItems ?? 0,
      });
      const services = out.judgments.filter((j) => j.verdict === 'service').length;
      this.logger.log(
        `후보 ${items.length}개: 저장된 판정 ${out.cached}개, 새로 물음 ${out.asked}개(답 없음 ${out.unanswered}), 서비스 ${services}개 (${Date.now() - t0}ms, 토큰 입력 ${out.usage.input} · 출력 ${out.usage.output})`,
      );
      return out.judgments;
    } catch (err) {
      if (err instanceof ApiException) {
        if (err.code === 'DETECTION_UNAVAILABLE') this.logger.warn(`판정할 수 없음: AI 키가 없고 처음 보는 후보가 있음`);
        throw err;
      }
      const reason = err instanceof Anthropic.APIError ? `API ${err.status ?? '-'} ${err.name}` : err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI 판정 실패: ${reason}`);
      throw new ApiException('DETECTION_UNAVAILABLE');
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
