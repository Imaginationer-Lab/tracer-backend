// GitHub tarball(.tar.gz)을 디스크에 풀지 않고 메모리에서 RepoFile[]로 바꾼다.
// 남이 만든 압축 파일이라: 일반 파일만 읽고(심볼릭 링크 무시), '..' 경로를 버리고, 파일 수와 풀린 크기에 상한을 둔다.

import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar-stream';
import { classifyPath, MAX_SOURCE_BYTES } from '../../engine/files.js';
import type { RepoFile } from '../../engine/types.js';
import { ApiException } from '../errors.js';

export interface TarLimits {
  maxFiles: number;
  /** 풀린 내용 전체 상한 (읽는 파일만 센다) */
  maxBytes: number;
}

export async function extractRepoFiles(tarball: Buffer, limits: TarLimits): Promise<RepoFile[]> {
  const files: RepoFile[] = [];
  let totalBytes = 0;
  const ex = extract();

  const done = new Promise<void>((resolve, reject) => {
    ex.on('entry', (header, stream, next) => {
      const drain = () => {
        stream.on('end', next);
        stream.resume();
      };
      // GitHub tarball의 첫 경로는 '{owner}-{repo}-{sha}/'
      const path = header.name.split('/').slice(1).join('/');
      if (header.type !== 'file' || !path || path.split('/').some((s) => s === '..' || s === '') || path.startsWith('/')) return drain();

      const role = classifyPath(path);
      if (role.kind === 'ignored') return drain();
      if (files.length >= limits.maxFiles) {
        ex.destroy(new ApiException('REPO_TOO_LARGE'));
        return;
      }
      if (role.kind === 'other') {
        files.push({ path, content: '' });
        return drain();
      }

      // 너무 큰 파일은 앞부분만 남긴다 (엔진이 'too-large'로 건너뛰도록 상한+1까지)
      const chunks: Buffer[] = [];
      let kept = 0;
      stream.on('data', (data: unknown) => {
        const chunk = data as Buffer;
        totalBytes += chunk.length;
        if (totalBytes > limits.maxBytes) {
          ex.destroy(new ApiException('REPO_TOO_LARGE'));
          return;
        }
        if (kept <= MAX_SOURCE_BYTES) {
          chunks.push(chunk);
          kept += chunk.length;
        }
      });
      stream.on('end', () => {
        files.push({ path, content: Buffer.concat(chunks).toString('utf8') });
        next();
      });
      stream.on('error', reject);
    });
    ex.on('finish', resolve);
    ex.on('error', reject);
  });

  const gunzip = createGunzip();
  gunzip.on('error', (err) => ex.destroy(err));
  Readable.from(tarball).pipe(gunzip).pipe(ex);
  await done;
  return files;
}
