// 분석 요청 흐름
//   POST: URL 검사 → GitHub에서 저장소·커밋 확인(동기) → 캐시(저장소+커밋+규칙 버전) 확인
//         → 없으면 트리로 받을 파일을 정함(동기, 너무 크면 여기서 413) → IP 토큰 사용 → 작업 생성(202)
//         → 백그라운드에서 파일 받기(tarball 또는 필요한 파일만)
//         → 엔진 1차(규칙 없이 후보 모으기) → AI 판정 → 판정으로 만든 규칙으로 엔진 2차 → 저장
//   캐시 적중, 형식 오류, 크기 초과, GitHub 오류는 IP 토큰을 쓰지 않는다.

import { randomBytes } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Analysis, ProviderDetail, ProviderId, StepKey, StepState } from '../../api/contract.js';
import { rulesFromJudgments } from '../../engine/learn.js';
import { ENGINE_VERSION, SERVICE_ID } from '../../engine/rules.js';
import { AnalysisRepository, type AnalysisRecord } from '../db/analysis.repository.js';
import { ApiException, ERRORS } from '../errors.js';
import { GitHubClient, parseRepoUrl } from '../github/github.client.js';
import { RepoLoader, type LoadPlan } from '../github/repo-loader.js';
import { ClueClassifier } from '../llm/clue-classifier.js';
import { hostTargets, serviceInfo } from '../../api/present.js';
import { HostProber } from '../providers/host-probe.js';
import { StatusRegistry } from '../providers/status-registry.js';
import { EnginePool } from './engine-pool.js';
import { RateLimiter } from './rate-limiter.js';

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

  constructor(
    private readonly repo: AnalysisRepository,
    private readonly github: GitHubClient,
    private readonly loader: RepoLoader,
    private readonly pool: EnginePool,
    private readonly limiter: RateLimiter,
    private readonly classifier: ClueClassifier,
    private readonly status: StatusRegistry,
    private readonly prober: HostProber,
  ) {}

  async onModuleInit(): Promise<void> {
    const n = await this.repo.failInterrupted({ code: 'INTERNAL_ERROR', message: '서버가 다시 시작되어 분석이 중단됐어요. 다시 분석해 주세요.', retryable: true });
    if (n) this.logger.warn(`중단된 분석 ${n}건을 실패로 표시`);
  }

  async create(repoUrl: unknown, ip: string): Promise<{ analysis: Analysis; created: boolean }> {
    const { owner, name } = parseRepoUrl(repoUrl);
    const ref = await this.github.resolveRepo(owner, name);
    const version = this.version;

    const cached = await this.repo.findByCommit(ref, version);
    if (cached && cached.status !== 'failed') return { analysis: this.withStatus(toAnalysis(cached)), created: false };

    if (this.pool.busy) throw new ApiException('RATE_LIMITED', { retryAfter: 30 });
    const plan = await this.loader.plan(ref);
    const token = this.limiter.take(ip);
    if (!token.ok) throw new ApiException('RATE_LIMITED', { retryAfter: token.retryAfter });

    const id = `an_${randomBytes(8).toString('hex')}`;
    const initial = steps('done', 'running', 'pending');
    const inserted = await this.repo.insertRunning(id, ref, version, initial);
    if (!inserted) {
      // 같은 커밋을 다른 요청이 방금 시작했다: 그 분석을 돌려준다
      this.limiter.refund(ip);
      const other = await this.repo.findByCommit(ref, version);
      if (other) return { analysis: this.withStatus(toAnalysis(other)), created: false };
      throw new ApiException('INTERNAL_ERROR');
    }

    void this.run(id, ref, plan);
    return { analysis: { id, status: 'running', repo: ref, steps: initial, error: null, result: null }, created: true };
  }

  async get(id: string): Promise<Analysis> {
    const record = await this.repo.findById(id);
    if (!record) throw new ApiException('ANALYSIS_NOT_FOUND');
    return this.withStatus(toAnalysis(record));
  }

  /**
   * statusSupport는 읽을 때 정한다. 분석이 끝난 뒤 상태 페이지를 찾았으면 다음 조회부터 'live'.
   * 아직 찾아보지 않은 서비스는 여기서 백그라운드 찾기를 건다 (예전에 끝난 분석 포함, 서비스마다 한 번).
   */
  private withStatus(a: Analysis): Analysis {
    if (!a.result) return a;
    this.status.discover(a.result.providers.map((p) => ({ id: p.id, name: p.name })));
    return { ...a, result: { ...a.result, providers: a.result.providers.map((p) => ({ ...p, statusSupport: this.status.support(p.id) })) } };
  }

  /** 이 분석 결과에 있는 서비스만. 없으면 PROVIDER_NOT_FOUND */
  async providerDetail(id: string, providerId: string): Promise<ProviderDetail> {
    if (!SERVICE_ID.test(providerId)) throw new ApiException('PROVIDER_NOT_FOUND');
    const record = await this.repo.findById(id);
    if (!record) throw new ApiException('ANALYSIS_NOT_FOUND');
    if (record.status === 'failed' && record.error) throw ApiException.fromJSON(record.error);
    if (record.status !== 'done') throw new ApiException('ANALYSIS_NOT_READY');
    const detail = record.details && Object.hasOwn(record.details, providerId) ? record.details[providerId as ProviderId] : undefined;
    if (!detail) throw new ApiException('PROVIDER_NOT_FOUND');
    const { targets, ...rest } = detail;
    const page = this.status.source(providerId)?.pageUrl;
    const provider = page && !rest.provider.statusPageUrl ? { ...rest.provider, statusPageUrl: page } : rest.provider;
    // 예전 결과에는 targets가 없어서 저장된 근거의 endpoint로 정한다
    const list =
      targets ??
      hostTargets(
        rest.evidence.flatMap((e) => (e.endpoint ? [{ host: e.endpoint.host, path: e.path, line: e.line }] : [])),
        serviceInfo(providerId as ProviderId, new Map()),
      );
    return { ...rest, provider, hosts: await this.prober.hosts(list) };
  }

  private async run(id: string, ref: Analysis['repo'], plan: LoadPlan): Promise<void> {
    let current: StepKey = 'files';
    try {
      const t0 = Date.now();
      const files = await this.loader.load(ref, plan);
      const how = plan.via === 'files' ? `필요한 파일만 ${plan.plan.fetch.length}개` : 'tarball';
      this.logger.log(`${ref.owner}/${ref.name}@${ref.commit.slice(0, 7)} 파일 받음: ${how}, ${Date.now() - t0}ms`);
      current = 'detect';
      await this.repo.updateSteps(id, steps('done', 'done', 'running'));
      // 1차: 규칙 없이 후보(의존성·호스트·HTTP 호출)만 모은다
      const candidates = await this.pool.run(files);
      // AI 판정 (저장된 판정은 다시 묻지 않음). 처음 보는 후보를 판정하지 못하면 DETECTION_UNAVAILABLE
      const judgments = await this.classifier.judge(candidates.ambiguous);
      const detection = rulesFromJudgments(candidates.ambiguous, judgments);
      // 2차: 판정으로 만든 규칙으로 줄 번호·호출 추적·코드 사실을 찾는다
      const out = detection.rules.length || detection.direct.length ? await this.pool.run(files, detection) : candidates;
      await this.repo.markDone(id, steps('done', 'done', 'done'), out);
      // 상태 API가 없는 서비스는 공식 상태 페이지를 백그라운드로 찾는다
      this.status.discover(out.result.providers.map((p) => ({ id: p.id, name: p.name })));
      this.logger.log(
        `${ref.owner}/${ref.name}@${ref.commit.slice(0, 7)} 완료: 파일 ${files.length}개, 파싱 ${out.stats.parsedFiles}개, 후보 ${candidates.ambiguous.length}개, 서비스 ${out.result.providers.length}개 (규칙 ${detection.rules.length}개)`,
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

  /** 분석 캐시 키: 엔진 버전 + 판정 방식(모델·프롬프트 버전). 바뀌면 같은 커밋도 다시 분석한다 */
  private get version(): string {
    return `e${ENGINE_VERSION}${this.classifier.versionTag}`;
  }
}
