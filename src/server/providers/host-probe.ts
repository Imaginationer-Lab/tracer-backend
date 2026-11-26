// 공식 상태 API가 없는 서비스도 "지금 서버가 응답하는지"를 보여 주려고, 근거에 나온 호스트 루트에 키 없이 GET을 한 번 보낸다.
//   - 경로·쿼리는 쓰지 않는다 (GET인데 뭔가를 실행하는 주소를 건드리지 않게). 본문·인증 정보도 보내지 않는다.
//   - 호스트는 남의 저장소에서 나온 값이라 상태 페이지 검증과 같은 주소 검사를 한다 (status-verify.checkHost). 리다이렉트는 따라가지 않는다.
//   - 호스트 단위 60초 캐시를 서버 전체가 같이 쓰고, 같은 호스트를 동시에 물으면 요청 하나를 같이 기다린다.
//   - 실패하면 알려진 외부 주소를 하나 더 불러서, 그것도 안 되면 우리 쪽 문제로 보고 '확인 불가'로 둔다.

import { Injectable } from '@nestjs/common';
import type { HostProbe, ServiceHost } from '../../api/contract.js';
import type { HostTarget } from '../../api/present.js';
import { checkHost, resolvePublic } from './status-verify.js';

const CACHE_MS = 60_000;
const MAX_CACHE = 5000;
const TIMEOUT_MS = 5000;
const BASELINE = 'https://www.google.com/generate_204';

export interface ProbeDeps {
  resolve: (host: string) => Promise<string[]>;
  /** 응답이 오면 상태 코드, 시간 초과·연결 실패면 throw */
  request: (url: string) => Promise<number>;
}

const defaultDeps: ProbeDeps = {
  resolve: resolvePublic,
  request: async (url) => {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'outage-map-host-check' } });
    // 본문은 읽지 않는다
    await res.body?.cancel().catch(() => undefined);
    return res.status;
  },
};

const LABEL: Record<HostProbe['result'], string> = { ok: '응답 있음', error: '응답 이상', unknown: '확인 불가' };

/** 401·404·421처럼 서버가 요청을 읽고 거절한 4xx도 살아 있다는 뜻. 403·429는 상대가 우리를 막은 것이라 알 수 없다 */
export function classifyStatus(status: number): HostProbe['result'] {
  if (status === 403 || status === 429) return 'unknown';
  if (status >= 500 && status < 600) return 'error';
  if (status >= 200 && status < 500) return 'ok';
  return 'unknown';
}

const make = (result: HostProbe['result'], httpStatus: number | null): HostProbe => ({ result, label: LABEL[result], httpStatus, checkedAt: new Date().toISOString() });

export async function probeHost(host: string, deps: ProbeDeps = defaultDeps): Promise<HostProbe> {
  let url: URL;
  try {
    url = new URL(`https://${host}/`);
  } catch {
    return make('unknown', null);
  }
  // 내부 주소로 풀리거나 DNS에서 안 풀리면 부르지 않는다
  if (url.hostname !== host || !(await checkHost(url, deps))) return make('unknown', null);
  let status: number | null = null;
  try {
    status = await deps.request(url.href);
  } catch {
    status = null;
  }
  const result = status === null ? 'error' : classifyStatus(status);
  if (result !== 'error') return make(result, status);
  // 응답 이상이면 우리 서버 네트워크 문제인지 가려낸다
  try {
    await deps.request(BASELINE);
  } catch {
    return make('unknown', status);
  }
  return make('error', status);
}

@Injectable()
export class HostProber {
  private readonly cache = new Map<string, { value: Promise<HostProbe>; expires: number }>();

  /** 테스트에서 바꿔 끼운다 */
  deps: ProbeDeps = defaultDeps;

  probe(host: string): Promise<HostProbe> {
    const now = Date.now();
    const hit = this.cache.get(host);
    if (hit && hit.expires > now) return hit.value;
    if (this.cache.size >= MAX_CACHE) for (const [k, v] of this.cache) if (v.expires <= now) this.cache.delete(k);
    if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    const value = probeHost(host, this.deps);
    this.cache.set(host, { value, expires: now + CACHE_MS });
    return value;
  }

  async hosts(targets: HostTarget[]): Promise<ServiceHost[]> {
    return Promise.all(targets.map(async (t) => ({ name: t.name, host: t.host, probe: await this.probe(t.host), files: t.files })));
  }
}
