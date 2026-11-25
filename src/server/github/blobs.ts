// 필요한 파일 내용만 GitHub GraphQL로 받는다. 한 쿼리에 파일 여러 개(별칭)를 묶고, 쿼리 몇 개를 동시에 보낸다.
// 쿼리 하나가 GraphQL 한도(시간당 5,000점)에서 1점이라, 파일 2,000개도 40점 남짓이다.

import type { RepoRef } from '../../api/contract.js';
import type { RepoFile } from '../../engine/types.js';
import { ApiException } from '../errors.js';

export interface GraphQLResponse {
  data?: { repository?: Record<string, { text: string | null } | null> | null } | null;
  errors?: { type?: string; message?: string }[];
}

/** 쿼리 하나 보내기. HTTP 오류는 여기서 ApiException으로 바꿔서 던진다 */
export type GraphQL = (query: string) => Promise<GraphQLResponse>;

export interface BlobOptions {
  batch: number;
  concurrency: number;
}

export function blobQuery(repo: RepoRef, paths: string[]): string {
  // GraphQL 문자열 이스케이프는 JSON과 같다
  const fields = paths.map((p, i) => `f${i}: object(expression: ${JSON.stringify(`${repo.commit}:${p}`)}) { ... on Blob { text } }`).join('\n');
  return `query { repository(owner: ${JSON.stringify(repo.owner)}, name: ${JSON.stringify(repo.name)}) {\n${fields}\n} }`;
}

async function fetchBatch(repo: RepoRef, paths: string[], gql: GraphQL): Promise<RepoFile[]> {
  let res: GraphQLResponse | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await gql(blobQuery(repo, paths));
      if (!res.errors?.length) break;
      if (res.errors.some((e) => e.type === 'RATE_LIMITED')) throw new ApiException('GITHUB_RATE_LIMITED');
      throw new ApiException('GITHUB_UNAVAILABLE');
    } catch (err) {
      // 일시 오류만 한 번 더
      if (attempt === 0 && err instanceof ApiException && err.code === 'GITHUB_UNAVAILABLE') continue;
      throw err;
    }
  }
  const repoData = res.data?.repository;
  if (!repoData) throw new ApiException('REPO_NOT_ACCESSIBLE');
  // text가 null이면 바이너리, 객체가 null이면 그 커밋에 없는 경로: 내용 없이 둔다
  return paths.map((path, i) => ({ path, content: repoData[`f${i}`]?.text ?? '' }));
}

export async function fetchBlobs(repo: RepoRef, paths: string[], gql: GraphQL, opts: BlobOptions = { batch: 50, concurrency: 8 }): Promise<RepoFile[]> {
  const batches: string[][] = [];
  for (let i = 0; i < paths.length; i += opts.batch) batches.push(paths.slice(i, i + opts.batch));
  const results: RepoFile[][] = new Array(batches.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < batches.length) {
      const i = next++;
      try {
        results[i] = await fetchBatch(repo, batches[i]!, gql);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, batches.length) }, worker));
  return results.flat();
}
