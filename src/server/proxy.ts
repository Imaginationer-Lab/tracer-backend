// TRUST_PROXY → Fastify trustProxy 옵션. 숫자면 "끝에서부터 믿을 프록시 단계 수" (docs/deploy.md "프록시와 TRUST_PROXY")
//   브라우저 → Cloudflare → 프론트 서버 → 백엔드 라면 2: 프론트 서버(직접 연결)와 Cloudflare를 건너뛰고 그다음 주소를 사용자 IP로 본다.

import type { AppConfig } from './config.js';

export function trustProxyOption(value: AppConfig['trustProxy']): boolean | string | ((addr: string, hop: number) => boolean) {
  if (typeof value !== 'number') return value;
  return (_addr: string, hop: number) => hop < value;
}
