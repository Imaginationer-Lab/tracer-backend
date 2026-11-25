// piscina 워커 진입점. 분석은 CPU를 쓰므로 API 요청을 처리하는 메인 스레드와 분리한다.
// 원문(texts)은 크기가 커서 돌려보내지 않고, 응답에 필요한 모양으로 바꿔서 보낸다.

import { toAnalysisResult, toProviderDetail } from '../api/present.js';
import type { AnalysisResult, ProviderDetail, ProviderId } from '../api/contract.js';
import { analyze } from './analyze.js';
import { PROVIDER_IDS } from './rules.js';
import type { AmbiguousItem, RepoFile } from './types.js';

export interface WorkerOutput {
  result: AnalysisResult;
  details: Partial<Record<ProviderId, ProviderDetail>>;
  ambiguous: AmbiguousItem[];
  stats: { parsedFiles: number; sourceChars: number; rulesetVersion: string };
}

export default async function run(files: RepoFile[]): Promise<WorkerOutput> {
  const r = await analyze(files);
  const result = toAnalysisResult(r);
  const details: WorkerOutput['details'] = {};
  for (const id of PROVIDER_IDS) if (result.providers.some((p) => p.id === id)) details[id] = toProviderDetail(r, id);
  return {
    result,
    details,
    ambiguous: r.ambiguous,
    stats: { parsedFiles: r.stats.parsedFiles, sourceChars: r.stats.sourceChars, rulesetVersion: r.stats.rulesetVersion },
  };
}
