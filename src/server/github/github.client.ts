// GitHub REST 호출. 분석 1회에 3번 (저장소, 커밋, tarball)만 부른다.

import { Inject, Injectable } from '@nestjs/common';
import type { RepoRef } from '../../api/contract.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ApiException } from '../errors.js';

const API = 'https://api.github.com';
const REPO_CACHE_MS = 60_000;

/** https://github.com/{owner}/{repo} (앞뒤 공백, .git, 끝 슬래시, 하위 경로 허용) */
export function parseRepoUrl(input: unknown): { owner: string; name: string } {
  if (typeof input !== 'string') throw new ApiException('INVALID_REPO_URL');
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:\/.*)?$/.exec(input.trim());
  if (!m || m[2] === '.' || m[2] === '..') throw new ApiException('INVALID_REPO_URL');
  return { owner: m[1]!, name: m[2]! };
}

@Injectable()
export class GitHubClient {
  private readonly repoCache = new Map<string, { value: RepoRef; expires: number }>();

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  /** 기본 브랜치와 최신 커밋. 비공개 저장소는 서버 토큰으로 보이더라도 거부한다. */
  async resolveRepo(owner: string, name: string): Promise<RepoRef> {
    const cacheKey = `${owner}/${name}`.toLowerCase();
    const hit = this.repoCache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.value;

    const repo = (await this.getJson(`/repos/${owner}/${name}`)) as { private: boolean; default_branch: string; size: number; owner: { login: string }; name: string };
    if (repo.private) throw new ApiException('REPO_NOT_ACCESSIBLE');
    // size는 KB. 압축 전 저장소 전체 크기라 tarball 상한의 몇 배까지는 봐준다
    if (repo.size * 1024 > this.cfg.maxTarballBytes * 4) throw new ApiException('REPO_TOO_LARGE');
    const commit = (await this.getJson(`/repos/${owner}/${name}/commits/${encodeURIComponent(repo.default_branch)}`)) as { sha: string };

    const value: RepoRef = { owner: repo.owner.login, name: repo.name, branch: repo.default_branch, commit: commit.sha };
    this.repoCache.set(cacheKey, { value, expires: Date.now() + REPO_CACHE_MS });
    return value;
  }

  async downloadTarball(repo: RepoRef): Promise<Buffer> {
    const res = await this.request(`/repos/${repo.owner}/${repo.name}/tarball/${repo.commit}`, 60_000);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > this.cfg.maxTarballBytes) throw new ApiException('REPO_TOO_LARGE');
    if (!res.body) throw new ApiException('GITHUB_UNAVAILABLE');
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > this.cfg.maxTarballBytes) {
        await reader.cancel();
        throw new ApiException('REPO_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  private async getJson(path: string): Promise<unknown> {
    const res = await this.request(path, 10_000);
    return res.json();
  }

  private async request(path: string, timeoutMs: number): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'outage-map-analyzer',
          ...(this.cfg.githubToken ? { Authorization: `Bearer ${this.cfg.githubToken}` } : {}),
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ApiException('GITHUB_UNAVAILABLE');
    }
    if (res.ok) return res;

    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if ((res.status === 403 || res.status === 429) && (remaining === '0' || res.headers.has('retry-after'))) {
      const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : new Date(Date.now() + Number(res.headers.get('retry-after') ?? 60) * 1000).toISOString();
      throw new ApiException('GITHUB_RATE_LIMITED', { resetAt });
    }
    // 404: 없거나 비공개, 409: 빈 저장소, 451: 법적 차단
    if ([401, 403, 404, 409, 451].includes(res.status)) throw new ApiException('REPO_NOT_ACCESSIBLE');
    throw new ApiException('GITHUB_UNAVAILABLE');
  }
}
