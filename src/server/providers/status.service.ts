// FEAT-003 공급자 공개 상태. 서버가 대신 불러서 60초 캐시한다 (브라우저 CORS 회피, 상태 API 부하 줄이기).
// 조회에 실패하면 "정상"으로 채우지 않고 STATUS_UNAVAILABLE을 돌려준다.

import { Injectable } from '@nestjs/common';
import type { ProviderId, ProviderStatus } from '../../api/contract.js';
import { PROVIDER_IDS, PROVIDERS } from '../../engine/rules.js';
import { ApiException } from '../errors.js';

const CACHE_MS = 60_000;

const INDICATOR: Record<string, ProviderStatus['state']> = {
  none: 'operational',
  minor: 'degraded',
  major: 'outage',
  critical: 'outage',
  maintenance: 'maintenance',
};

@Injectable()
export class StatusService {
  private readonly cache = new Map<ProviderId, { value: ProviderStatus; expires: number }>();

  async get(providerId: string): Promise<ProviderStatus> {
    if (!PROVIDER_IDS.includes(providerId as ProviderId)) throw new ApiException('PROVIDER_NOT_FOUND');
    const id = providerId as ProviderId;
    const api = PROVIDERS[id].statusApi;
    if (!api) throw new ApiException('STATUS_NOT_SUPPORTED');

    const hit = this.cache.get(id);
    if (hit && hit.expires > Date.now()) return hit.value;

    let body: { status?: { indicator?: string; description?: string } };
    try {
      const res = await fetch(api, { signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`status ${res.status}`);
      body = (await res.json()) as typeof body;
    } catch {
      throw new ApiException('STATUS_UNAVAILABLE');
    }
    const indicator = body.status?.indicator;
    if (!indicator || typeof body.status?.description !== 'string') throw new ApiException('STATUS_UNAVAILABLE');

    const value: ProviderStatus = {
      providerId: id,
      indicator,
      state: INDICATOR[indicator] ?? 'unknown',
      description: body.status.description,
      fetchedAt: new Date().toISOString(),
    };
    this.cache.set(id, { value, expires: Date.now() + CACHE_MS });
    return value;
  }
}
