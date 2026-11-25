// piscina 워커 진입점. 분석은 CPU를 쓰므로 API 요청을 처리하는 메인 스레드와 분리한다.
// 원문(texts)은 크기가 커서 돌려보내지 않고, 응답과 저장에 필요한 모양으로 바꿔서 보낸다.

import { toAnalysisResult, toProviderDetail } from '../api/present.js';
import type { AnalysisResult, ProviderDetail, ProviderId } from '../api/contract.js';
import { analyze } from './analyze.js';
import { PROVIDER_IDS, type Rule } from './rules.js';
import type { AmbiguousItem, Location, RepoFile } from './types.js';

export interface WorkerInput {
  files: RepoFile[];
  rules?: Rule[];
}

/** 저장소가 쓰는 공급자 엔드포인트 (host로 판정한 것만) */
export interface EndpointUse {
  provider: ProviderId;
  host: string;
  path: string;
  occurrences: Location[];
}

export interface WorkerOutput {
  result: AnalysisResult;
  details: Partial<Record<ProviderId, ProviderDetail>>;
  ambiguous: AmbiguousItem[];
  endpoints: EndpointUse[];
  stats: { parsedFiles: number; sourceChars: number; rulesetVersion: string };
}

export default async function run({ files, rules }: WorkerInput): Promise<WorkerOutput> {
  const r = await analyze(files, rules ? { rules } : {});
  const result = toAnalysisResult(r);
  const details: WorkerOutput['details'] = {};
  for (const id of PROVIDER_IDS) if (result.providers.some((p) => p.id === id)) details[id] = toProviderDetail(r, id);

  const endpoints = new Map<string, EndpointUse>();
  for (const e of r.evidence) {
    if (!e.endpoint) continue;
    const path = e.endpoint.path ?? '';
    const key = `${e.provider}|${e.endpoint.host}|${path}`;
    const cur = endpoints.get(key) ?? { provider: e.provider, host: e.endpoint.host, path, occurrences: [] };
    cur.occurrences.push({ path: e.path, line: e.line });
    endpoints.set(key, cur);
  }

  return {
    result,
    details,
    ambiguous: r.ambiguous,
    endpoints: [...endpoints.values()],
    stats: { parsedFiles: r.stats.parsedFiles, sourceChars: r.stats.sourceChars, rulesetVersion: r.stats.rulesetVersion },
  };
}
