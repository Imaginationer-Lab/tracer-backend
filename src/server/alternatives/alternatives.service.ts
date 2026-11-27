// GET /analyses/:id/providers/:providerId/alternatives
//   판단은 스킬 문서(skills/alternatives)를 읽은 AI가 하고, 답은 JSON 스키마로 받는다.
//   저장된 결과(키: 서비스 + 쓰는 호출·코드 + 저장소의 같은 분류 서비스)가 있으면 바로, 없으면 AI에게 묻고 저장한다.
//   새로 물을 때만 IP 토큰을 쓴다. 같은 키를 동시에 물으면 요청 하나를 같이 기다린다.

import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ProviderAlternatives, ProviderId } from '../../api/contract.js';
import { SERVICE_ID } from '../../engine/rules.js';
import { RateLimiter } from '../analyses/rate-limiter.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { AnalysisRepository } from '../db/analysis.repository.js';
import { ApiException } from '../errors.js';
import { StatusRegistry } from '../providers/status-registry.js';
import { ALT_SCHEMA, altKey, buildAltInput, loadSkill, parseAltPlan, presentAlternatives, skillMessage, useGroups, type AltInput, type AltPlan, type Skill } from './alternatives.js';

@Injectable()
export class AlternativesService {
  private readonly logger = new Logger('Alternatives');
  private readonly client: Anthropic | null;
  private readonly inflight = new Map<string, Promise<{ plan: AltPlan; createdAt: Date }>>();
  private readonly skill: Skill = loadSkill();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly repo: AnalysisRepository,
    private readonly limiter: RateLimiter,
    private readonly status: StatusRegistry,
  ) {
    // 테스트(고정 판정) 모드나 AI 키가 없으면 새로 묻지 않는다
    this.client = cfg.llm && !cfg.clueFixtureFile ? new Anthropic({ apiKey: cfg.llm.apiKey, timeout: 60_000, maxRetries: 1 }) : null;
  }

  async get(id: string, providerId: string, ip: string): Promise<ProviderAlternatives> {
    if (!SERVICE_ID.test(providerId)) throw new ApiException('PROVIDER_NOT_FOUND');
    const record = await this.repo.findById(id);
    if (!record) throw new ApiException('ANALYSIS_NOT_FOUND');
    if (record.status === 'failed' && record.error) throw ApiException.fromJSON(record.error);
    if (record.status !== 'done' || !record.result) throw new ApiException('ANALYSIS_NOT_READY');
    const summary = record.result.providers.find((p) => p.id === providerId);
    const detail = record.details && Object.hasOwn(record.details, providerId) ? record.details[providerId as ProviderId] : undefined;
    if (!summary || !detail) throw new ApiException('PROVIDER_NOT_FOUND');

    const groups = useGroups(detail.evidence);
    const input = buildAltInput(
      { id: summary.id, name: summary.name, category: summary.category, role: summary.role },
      groups,
      record.result.providers.filter((p) => p.id !== providerId && p.category === summary.category).map((p) => ({ id: p.id, name: p.name, category: p.category })),
    );
    const key = altKey(input, this.cfg.alternativesModel, this.skill.version);
    const saved = (await this.repo.findAlternatives(key)) ?? (await this.create(key, input, ip));
    this.status.discover(saved.plan.alternatives.map((a) => ({ id: a.id, name: a.name })));
    return {
      providerId: summary.id,
      ...presentAlternatives(saved.plan, groups, (alt) => this.status.support(alt)),
      generatedAt: saved.createdAt.toISOString(),
    };
  }

  private create(key: string, input: AltInput, ip: string): Promise<{ plan: AltPlan; createdAt: Date }> {
    const running = this.inflight.get(key);
    if (running) return running;
    if (!this.client || !input.uses.length) throw new ApiException('ALTERNATIVES_UNAVAILABLE');
    const token = this.limiter.take(ip);
    if (!token.ok) throw new ApiException('RATE_LIMITED', { retryAfter: token.retryAfter });
    const job = (async () => {
      const t0 = Date.now();
      try {
        const plan = await this.ask(input);
        const createdAt = await this.repo.saveAlternatives(key, input.service.id, plan);
        this.logger.log(`${input.service.id} 대체 ${plan.alternatives.map((a) => `${a.id}(${a.fit})`).join(', ') || '없음'} (${Date.now() - t0}ms)`);
        return { plan, createdAt };
      } catch (err) {
        this.limiter.refund(ip);
        this.logger.warn(`${input.service.id} 대체 서비스 실패: ${err instanceof Error ? err.message : String(err)}`);
        throw new ApiException('ALTERNATIVES_UNAVAILABLE');
      }
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  private async ask(input: AltInput): Promise<AltPlan> {
    const res = await this.client!.messages.create({
      model: this.cfg.alternativesModel,
      max_tokens: 8000,
      system: this.skill.instructions,
      messages: [{ role: 'user', content: skillMessage(this.skill, input) }],
      // 서비스 지식과 기능 대조가 필요해서 medium. 답은 스키마로 받는다
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: ALT_SCHEMA as unknown as Record<string, unknown> } },
    });
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') throw new Error(`stop: ${res.stop_reason}`);
    const plan = parseAltPlan(res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''), input);
    if (!plan) throw new Error('응답 모양이 다름');
    return plan;
  }
}
