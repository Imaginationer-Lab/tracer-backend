// 로컬 디렉터리를 RepoFile[]로 읽는다 (테스트·CLI용). 서버는 GitHub tarball에서 같은 모양을 만든다.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { classifyPath } from './files.js';
import type { RepoFile } from './types.js';

export function loadRepoFromDir(root: string): RepoFile[] {
  const out: RepoFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const path = relative(root, full).split(sep).join('/');
      if (statSync(full).isDirectory()) {
        if (name !== '.git') walk(full);
        continue;
      }
      const role = classifyPath(path);
      if (role.kind === 'ignored') continue;
      // 분석 대상이 아닌 파일은 경로만 (파일 트리 표시용)
      out.push({ path, content: role.kind === 'other' ? '' : readFileSync(full, 'utf8') });
    }
  };
  walk(root);
  return out;
}
