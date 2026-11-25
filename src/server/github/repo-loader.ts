// 저장소 파일을 어떻게 받을지 정하고 받는다.
//   1) 트리(경로·크기 목록)를 먼저 본다 (요청 1번). 읽을 파일 수·크기가 한도를 넘으면 여기서 바로 REPO_TOO_LARGE.
//   2) 저장소 전체가 작으면 tarball 한 번 (요청 수가 가장 적다).
//      크면(이미지·영상·의존성 캐시가 큰 저장소) 필요한 파일만 GraphQL로 받는다.
//   트리가 잘릴 만큼 큰 저장소(항목 10만 개 이상)는 tarball로 받고, 받는 크기 상한으로 거른다.
// 실측 (2026-11-25): KOIN_WEB_RECODE 전체 591MB → 필요한 파일 972개 2.8MB, OpenMAIC 131MB → 2,266개 18MB (각각 약 12초)

import { Inject, Injectable } from '@nestjs/common';
import type { RepoRef } from '../../api/contract.js';
import type { RepoFile } from '../../engine/types.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ApiException } from '../errors.js';
import { GitHubClient } from './github.client.js';
import { planFetch, type FetchPlan } from './repo-plan.js';
import { extractRepoFiles } from './tarball.js';

export type LoadPlan = { via: 'tarball'; totalBytes?: number } | { via: 'files'; plan: FetchPlan };

@Injectable()
export class RepoLoader {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly github: GitHubClient,
  ) {}

  /** 요청을 받을 때 동기로 부른다. 너무 크면 분석 작업을 만들기 전에 거절한다 */
  async plan(ref: RepoRef): Promise<LoadPlan> {
    const tree = await this.github.getTree(ref);
    if (tree.truncated) return { via: 'tarball' };
    const plan = planFetch(tree.entries, { maxFiles: this.cfg.maxRepoFiles, maxFetchBytes: this.cfg.maxSourceBytes });
    if (plan.totalBytes <= this.cfg.maxTarballBytes) return { via: 'tarball', totalBytes: plan.totalBytes };
    if (!this.github.canFetchFiles) throw new ApiException('REPO_TOO_LARGE');
    return { via: 'files', plan };
  }

  async load(ref: RepoRef, plan: LoadPlan): Promise<RepoFile[]> {
    if (plan.via === 'tarball') {
      return extractRepoFiles(await this.github.openTarball(ref), { maxFiles: this.cfg.maxRepoFiles, maxBytes: this.cfg.maxSourceBytes });
    }
    const fetched = await this.github.fetchFiles(
      ref,
      plan.plan.fetch.map((f) => f.path),
    );
    return [...plan.plan.listed, ...fetched];
  }
}
