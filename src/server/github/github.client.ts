// GitHub 호출. 분석 1회에 REST 4번 (저장소, 커밋, 트리, tarball) 또는
// REST 3번 + GraphQL 몇 번 (큰 저장소에서 필요한 파일만 받을 때).

import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Inject, Injectable } from '@nestjs/common';
import type { RepoRef } from '../../api/contract.js';
import type { RepoFile } from '../../engine/types.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ApiException } from '../errors.js';
import { fetchBlobs, type GraphQLResponse } from './blobs.js';
import type { TreeEntry } from './repo-plan.js';

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

    const repo = (await this.getJson(`/repos/${owner}/${name}`)) as { private: boolean; default_branch: string; owner: { login: string }; name: string };
    if (repo.private) throw new ApiException('REPO_NOT_ACCESSIBLE');
    // 크기는 여기서 보지 않는다. repo.size는 git 기록까지 포함해서, 코드는 작아도 거절하게 된다 (트리로 판단: repo-plan.ts)
    const commit = (await this.getJson(`/repos/${owner}/${name}/commits/${encodeURIComponent(repo.default_branch)}`)) as { sha: string };

    const value: RepoRef = { owner: repo.owner.login, name: repo.name, branch: repo.default_branch, commit: commit.sha };
    this.repoCache.set(cacheKey, { value, expires: Date.now() + REPO_CACHE_MS });
    return value;
  }

  /** 경로·크기 목록. 항목이 10만 개를 넘거나 7MB를 넘으면 GitHub가 잘라서 truncated가 true다 */
  async getTree(repo: RepoRef): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const tree = (await this.getJson(`/repos/${repo.owner}/${repo.name}/git/trees/${repo.commit}?recursive=1`, 30_000)) as { tree: TreeEntry[]; truncated: boolean };
    return { entries: tree.tree, truncated: tree.truncated };
  }

  /** tarball을 메모리에 모으지 않고 스트림으로 넘긴다. 받은 크기가 상한을 넘으면 스트림이 REPO_TOO_LARGE로 끝난다 */
  async openTarball(repo: RepoRef): Promise<Readable> {
    const res = await this.request(`/repos/${repo.owner}/${repo.name}/tarball/${repo.commit}`, { timeoutMs: 120_000 });
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > this.cfg.maxTarballBytes) throw new ApiException('REPO_TOO_LARGE');
    if (!res.body) throw new ApiException('GITHUB_UNAVAILABLE');
    const max = this.cfg.maxTarballBytes;
    let size = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        cb(size > max ? new ApiException('REPO_TOO_LARGE') : null, chunk);
      },
    });
    const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
    body.on('error', (err) => cap.destroy(err instanceof ApiException ? err : new ApiException('GITHUB_UNAVAILABLE')));
    return body.pipe(cap);
  }

  /** GraphQL은 토큰이 있어야 쓸 수 있다 */
  get canFetchFiles(): boolean {
    return !!this.cfg.githubToken;
  }

  /** 필요한 파일 내용만 받는다 (blobs.ts) */
  async fetchFiles(repo: RepoRef, paths: string[]): Promise<RepoFile[]> {
    return fetchBlobs(repo, paths, async (query) => {
      const res = await this.request('/graphql', { timeoutMs: 30_000, method: 'POST', body: JSON.stringify({ query }) });
      return (await res.json()) as GraphQLResponse;
    });
  }

  private async getJson(path: string, timeoutMs = 10_000): Promise<unknown> {
    const res = await this.request(path, { timeoutMs });
    return res.json();
  }

  private async request(path: string, { timeoutMs, method = 'GET', body }: { timeoutMs: number; method?: string; body?: string }): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        ...(body ? { body } : {}),
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
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
