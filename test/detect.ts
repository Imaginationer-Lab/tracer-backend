// 테스트용 탐지: 1차 분석(후보) → 고정 판정(test/fixtures/judgments.json, AI 대신) → 판정으로 만든 규칙 → 2차 분석.
// 서버의 CLUE_FIXTURE_FILE 모드와 같은 판정을 쓴다.

import { readFileSync } from 'node:fs';
import { analyze } from '../src/engine/analyze.js';
import { applyDirect, clueKey, rulesFromJudgments, type DetectionPlan, type Judgment, type Verdict } from '../src/engine/learn.js';
import { loadRepoFromDir } from '../src/engine/load.js';
import type { ServiceInfo } from '../src/engine/rules.js';
import type { AmbiguousItem, EngineResult, RepoFile } from '../src/engine/types.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/judgments.json', import.meta.url), 'utf8')) as Record<string, Verdict>;

export const fixtureJudge = (items: AmbiguousItem[]): Judgment[] =>
  items.map((i) => ({ ...(FIXTURE[clueKey(i).replace(/^v\d+\|/, '')] ?? { verdict: 'unknown' as const }), id: i.id }));

export const fixtureFiles = (name: string): RepoFile[] =>
  loadRepoFromDir(new URL(`./fixtures/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

export interface Detection {
  files: RepoFile[];
  /** 1차 분석 (규칙 없음): 후보 */
  candidates: EngineResult;
  plan: DetectionPlan;
  /** 2차 분석 결과 */
  r: EngineResult;
  dir: Map<string, ServiceInfo>;
}

export async function detect(files: RepoFile[], judge = fixtureJudge): Promise<Detection> {
  const candidates = await analyze(files);
  const plan = rulesFromJudgments(candidates.ambiguous, judge(candidates.ambiguous));
  const r = applyDirect(await analyze(files, { rules: plan.rules }), plan.direct);
  return { files, candidates, plan, r, dir: new Map(plan.services.map((s) => [s.id, s])) };
}
