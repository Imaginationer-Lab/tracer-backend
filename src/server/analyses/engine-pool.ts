// 분석 엔진을 piscina 워커 스레드에서 돌린다. 메인 스레드(API 요청 처리)는 파싱에 막히지 않는다.
// 시간 상한을 넘긴 작업은 워커째 종료된다.

import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Piscina } from 'piscina';
import type { Rule } from '../../engine/rules.js';
import type { RepoFile } from '../../engine/types.js';
import type { WorkerInput, WorkerOutput } from '../../engine/worker.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ApiException } from '../errors.js';

@Injectable()
export class EnginePool implements OnModuleDestroy {
  private readonly pool: Piscina<WorkerInput, WorkerOutput>;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.pool = new Piscina({
      filename: new URL('../../engine/worker.js', import.meta.url).href,
      minThreads: 1,
      maxThreads: cfg.analyzerThreads,
      maxQueue: cfg.analyzerQueue,
      idleTimeout: 60_000,
    });
  }

  /** 대기열이 꽉 찼는지. 찼으면 새 분석을 받지 않는다 */
  get busy(): boolean {
    return this.pool.queueSize >= this.cfg.analyzerQueue;
  }

  async run(files: RepoFile[], rules: Rule[]): Promise<WorkerOutput> {
    try {
      return await this.pool.run({ files, rules }, { signal: AbortSignal.timeout(this.cfg.analysisTimeoutMs) });
    } catch (err) {
      if ((err as Error).name === 'AbortError' || (err as Error).name === 'TimeoutError') {
        throw new ApiException('REPO_TOO_LARGE', { message: '분석 시간이 너무 오래 걸려서 중단했어요.' });
      }
      throw err;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.destroy();
  }
}
