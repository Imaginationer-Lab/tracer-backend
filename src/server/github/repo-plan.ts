// GitHub 트리(경로·크기 목록)만 보고 무엇을 받을지 정한다. 내용은 아직 받지 않는다.
//   - 무시 폴더(node_modules 등)·심볼릭 링크·서브모듈은 뺀다.
//   - 분석 대상이 아닌 파일(README, 이미지 등)은 경로만 남긴다 (파일 트리 표시용).
//   - 분석 대상인데 512KB가 넘는 파일은 받지 않고 too-large로 표시한다.
// 그래서 한도는 저장소 전체 크기(git 기록·이미지·캐시 포함)가 아니라 "읽을 파일 수와 크기"로 건다.

import { classifyPath, MAX_SOURCE_BYTES } from '../../engine/files.js';
import type { RepoFile } from '../../engine/types.js';
import { ApiException } from '../errors.js';

/** GET /repos/{o}/{r}/git/trees/{sha}?recursive=1 의 tree[] 항목 */
export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  size?: number;
}

export interface PlanLimits {
  /** 트리에 남길 파일 수 (무시 폴더 제외) */
  maxFiles: number;
  /** 내용을 받을 파일들의 크기 합 */
  maxFetchBytes: number;
}

export interface FetchPlan {
  /** 내용 없이 경로만 넘길 파일 (분석 대상 아님, 또는 too-large) */
  listed: RepoFile[];
  /** 내용을 받을 파일 */
  fetch: { path: string; size: number }[];
  /** 트리의 모든 파일 크기 합. tarball을 받으면 대략 이만큼 받는다 */
  totalBytes: number;
  fetchBytes: number;
}

const SYMLINK = '120000';

export function planFetch(entries: TreeEntry[], limits: PlanLimits): FetchPlan {
  const listed: RepoFile[] = [];
  const fetch: FetchPlan['fetch'] = [];
  let totalBytes = 0;
  let fetchBytes = 0;
  for (const e of entries) {
    if (e.type !== 'blob') continue; // 디렉터리(tree), 서브모듈(commit)
    const size = e.size ?? 0;
    totalBytes += size;
    if (e.mode === SYMLINK || !e.path || e.path.split('/').some((s) => s === '..' || s === '')) continue;
    const role = classifyPath(e.path);
    if (role.kind === 'ignored') continue;
    if (listed.length + fetch.length >= limits.maxFiles) throw new ApiException('REPO_TOO_LARGE');
    if (role.kind === 'other') listed.push({ path: e.path, content: '' });
    else if (size > MAX_SOURCE_BYTES) listed.push({ path: e.path, content: '', tooLarge: true });
    else {
      fetch.push({ path: e.path, size });
      fetchBytes += size;
    }
  }
  if (fetchBytes > limits.maxFetchBytes) throw new ApiException('REPO_TOO_LARGE');
  return { listed, fetch, totalBytes, fetchBytes };
}
