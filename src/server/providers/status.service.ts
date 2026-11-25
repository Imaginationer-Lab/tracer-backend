// FEAT-003 공급자 공개 상태. 서버가 대신 불러서 60초 캐시한다 (브라우저 CORS 회피, 상태 API 부하 줄이기).
// 조회에 실패하면 "정상"으로 채우지 않고 STATUS_UNAVAILABLE을 돌려준다.

import { Injectable } from '@nestjs/common';
import type { ProviderId, ProviderStatus } from '../../api/contract.js';
import { SERVICE_ID } from '../../engine/rules.js';
import { ApiException } from '../errors.js';
import { StatusRegistry } from './status-registry.js';
import { readStatus } from './status-verify.js';

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

  constructor(private readonly registry: StatusRegistry) {}

  async get(providerId: string): Promise<ProviderStatus> {
    if (!SERVICE_ID.test(providerId)) throw new ApiException('PROVIDER_NOT_FOUND');
    const id = providerId as ProviderId;
    // 서버 목록 또는 AI 웹 검색으로 찾아 검증한 상태 API가 있는 서비스만. 없으면 "실시간 연동 전"
    const source = this.registry.source(id);
    if (!source) throw new ApiException('STATUS_NOT_SUPPORTED');

    const hit = this.cache.get(id);
    if (hit && hit.expires > Date.now()) return hit.value;

    // 주소 검사·크기 상한·모양 검사를 매번 다시 한다 (DB에 저장된 주소도 남이 찾아 온 것)
    const body = await readStatus(source.apiUrl);
    if (!body) throw new ApiException('STATUS_UNAVAILABLE');
    const indicator = body.indicator;

    const value: ProviderStatus = {
      providerId: id,
      indicator,
      state: INDICATOR[indicator] ?? 'unknown',
      description: body.description,
      fetchedAt: new Date().toISOString(),
    };
    this.cache.set(id, { value, expires: Date.now() + CACHE_MS });
    return value;
  }
}
