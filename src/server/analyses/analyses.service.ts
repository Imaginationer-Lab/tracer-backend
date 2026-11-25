// 분석 요청 흐름
//   POST: URL 검사 → GitHub에서 저장소·커밋 확인(동기) → 캐시(저장소+커밋+규칙 버전) 확인
//         → 없으면 IP 토큰 사용 → 작업 생성(202) → 백그라운드에서 tarball → 엔진 → 저장
//   캐시 적중, 형식 오류, GitHub 오류는 IP 토큰을 쓰지 않는다.

import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Analysis, ProviderDetail, ProviderId, StepKey, StepState } from '../../api/contract.js';
import { BUILTIN_RULES, PROVIDER_IDS, PROVIDERS, rulesetVersion, type Rule } from '../../engine/rules.js';
import type { WorkerOutput } from '../../engine/worker.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { AnalysisRepository, type AnalysisRecord } from '../db/analysis.repository.js';
import { ApiException, ERRORS } from '../errors.js';
import { GitHubClient, parseRepoUrl } from '../github/github.client.js';
import { extractRepoFiles } from '../github/tarball.js';
import { ClueClassifier } from '../llm/clue-classifier.js';
import { EnginePool } from './engine-pool.js';
import { RateLimiter } from './rate-limiter.js';

const RULES_TTL_MS = 60_000;

const steps = (repo: StepState, files: StepState, detect: StepState): Analysis['steps'] => [
  { key: 'repo', state: repo },
  { key: 'files', state: files },
  { key: 'detect', state: detect },
];

/** 응답에서 내부 필드를 뺀다 */
const toAnalysis = ({ rulesetVersion: _v, details: _d, ambiguous: _a, ...a }: AnalysisRecord): Analysis => a;

@Injectable()
export class AnalysesService implements OnModuleInit {
  private readonly logger = new Logger('Analyses');
  private rules: { list: Rule[]; version: string; loadedAt: number } | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly repo: AnalysisRepository,
    private readonly github: GitHubClient,
    private readonly pool: EnginePool,
    private readonly limiter: RateLimiter,
    private readonly classifier: ClueClassifier,
  ) {}

  async onModuleInit(): Promise<void> {
    const n = await this.repo.failInterrupted({ code: 'INTERNAL_ERROR', message: '서버가 다시 시작되어 분석이 중단됐어요. 다시 분석해 주세요.', retryable: true });
    if (n) this.logger.warn(`중단된 분석 ${n}건을 실패로 표시`);
  }

  async create(repoUrl: unknown, ip: string): Promise<{ analysis: Analysis; created: boolean }> {
    const { owner, name } = parseRepoUrl(repoUrl);
    const ref = await this.github.resolveRepo(owner, name);
    const rules = await this.currentRules();

    const cached = await this.repo.findByCommit(ref, rules.version);
    if (cached && cached.status !== 'failed') return { analysis: toAnalysis(cached), created: false };

    if (this.pool.busy) throw new ApiException('RATE_LIMITED', { retryAfter: 30 });
    const token = this.limiter.take(ip);
    if (!token.ok) throw new ApiException('RATE_LIMITED', { retryAfter: token.retryAfter });

    const id = `an_${randomBytes(8).toString('hex')}`;
    const initial = steps('done', 'running', 'pending');
    const inserted = await this.repo.insertRunning(id, ref, rules.version, initial);
    if (!inserted) {
      // 같은 커밋을 다른 요청이 방금 시작했다: 그 분석을 돌려준다
      this.limiter.refund(ip);
      const other = await this.repo.findByCommit(ref, rules.version);
      if (other) return { analysis: toAnalysis(other), created: false };
      throw new ApiException('INTERNAL_ERROR');
    }

    void this.run(id, ref, rules.list);
    return { analysis: { id, status: 'running', repo: ref, steps: initial, error: null, result: null }, created: true };
  }

  async get(id: string): Promise<Analysis> {
    const record = await this.repo.findById(id);
    if (!record) throw new ApiException('ANALYSIS_NOT_FOUND');
    return toAnalysis(record);
  }

  async providerDetail(id: string, providerId: string): Promise<ProviderDetail> {
    if (!PROVIDER_IDS.includes(providerId as ProviderId)) throw new ApiException('PROVIDER_NOT_FOUND');
    const record = await this.repo.findById(id);
    if (!record) throw new ApiException('ANALYSIS_NOT_FOUND');
    if (record.status === 'failed' && record.error) throw ApiException.fromJSON(record.error);
    if (record.status !== 'done') throw new ApiException('ANALYSIS_NOT_READY');
    const p = PROVIDERS[providerId as ProviderId];
    return record.details?.[providerId as ProviderId] ?? { provider: { id: p.id, name: p.name, statusPageUrl: p.statusPageUrl }, evidence: [] };
  }

  private async run(id: string, ref: Analysis['repo'], rules: Rule[]): Promise<void> {
    let current: StepKey = 'files';
    try {
      const tarball = await this.github.downloadTarball(ref);
      const files = await extractRepoFiles(tarball, { maxFiles: this.cfg.maxRepoFiles, maxBytes: this.cfg.maxTarballBytes * 8 });
      current = 'detect';
      await this.repo.updateSteps(id, steps('done', 'done', 'running'));
      let out: WorkerOutput = await this.pool.run(files, rules);
      const classifications = await this.classifier.classify(out.ambiguous);
      // 판정이 결과를 바꿀 때만 한 번 더 돌린다 (엔진은 결정적이라 후보 id가 그대로다)
      if (classifications.some((c) => c.provider === 'other' || PROVIDER_IDS.includes(c.provider as ProviderId))) {
        out = await this.pool.run(files, rules, classifications);
      }
      await this.repo.markDone(id, steps('done', 'done', 'done'), out);
      this.logger.log(
        `${ref.owner}/${ref.name}@${ref.commit.slice(0, 7)} 완료: 파일 ${files.length}개, 파싱 ${out.stats.parsedFiles}개, 애매 후보 ${out.ambiguous.length}개, 기타 서비스 ${out.result.otherServices.length}개`,
      );
    } catch (err) {
      const apiError = err instanceof ApiException ? err : new ApiException('INTERNAL_ERROR');
      if (!(err instanceof ApiException)) this.logger.error(`분석 실패 ${id}`, err instanceof Error ? err.stack : String(err));
      const failed = current === 'files' ? steps('done', 'failed', 'pending') : steps('done', 'done', 'failed');
      const { status: _s, ...base } = ERRORS[apiError.code];
      await this.repo
        .markFailed(id, failed, { code: apiError.code, ...base, message: apiError.message, ...apiError.extra })
        .catch((e) => this.logger.error(`실패 기록 저장 실패 ${id}`, e));
    }
  }

  /** 내장 규칙 + DB에 쌓인 학습 규칙. 규칙 버전이 캐시 키에 들어간다 */
  private async currentRules(): Promise<{ list: Rule[]; version: string }> {
    if (!this.rules || Date.now() - this.rules.loadedAt > RULES_TTL_MS) {
      const learned = await this.repo.loadLearnedRules();
      const list = [...BUILTIN_RULES, ...learned];
      this.rules = { list, version: rulesetVersion(list) + this.classifier.versionTag, loadedAt: Date.now() };
    }
    return this.rules;
  }
}
