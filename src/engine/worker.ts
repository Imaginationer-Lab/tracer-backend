// piscina 워커 진입점. 분석은 CPU를 쓰므로 API 요청을 처리하는 메인 스레드와 분리한다.
// 원문(texts)은 크기가 커서 돌려보내지 않고, 응답과 저장에 필요한 모양으로 바꿔서 보낸다.

import { toAnalysisResult, toProviderDetail, type StoredDetail } from '../api/present.js';
import type { AnalysisResult, ProviderId } from '../api/contract.js';
import { analyze } from './analyze.js';
import { applyDirect, type DetectionPlan } from './learn.js';
import type { Rule, ServiceInfo } from './rules.js';
import type { AmbiguousItem, Location, RepoFile } from './types.js';

export interface WorkerInput {
  files: RepoFile[];
  /** AI 판정에서 만든 이번 분석의 규칙. 없으면 후보만 모은다 */
  rules?: Rule[];
  /** 서비스 이름·분류·역할 (AI 판정 + 알려진 서비스) */
  services?: ServiceInfo[];
  direct?: DetectionPlan['direct'];
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
  details: Partial<Record<ProviderId, StoredDetail>>;
  ambiguous: AmbiguousItem[];
  endpoints: EndpointUse[];
  stats: { parsedFiles: number; sourceChars: number; rulesetVersion: string };
}

export default async function run({ files, rules, services, direct }: WorkerInput): Promise<WorkerOutput> {
  const r = applyDirect(await analyze(files, rules ? { rules } : {}), direct ?? []);
  const directory = new Map((services ?? []).map((s) => [s.id, s]));
  const result = toAnalysisResult(r, directory);
  const details: WorkerOutput['details'] = {};
  for (const p of result.providers) details[p.id] = toProviderDetail(r, p.id, directory);

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
