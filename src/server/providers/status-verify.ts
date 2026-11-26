// AI 웹 검색이 찾아 온 상태 페이지 주소를 서버가 직접 확인한다.
// 주소는 결국 남의 저장소에서 나온 서비스 이름으로 찾은 것이라, 서버가 아무 곳이나 부르지 않게 막는다:
//   https만 · IP 주소 대신 도메인만 · 사설·루프백·링크로컬 주소로 풀리면 거부 · 정해진 경로(/api/v2/status.json)만 ·
//   리다이렉트는 2번까지 같은 검사 · 응답 256KB·5초 상한 · Statuspage 모양(page.name, status.indicator)이어야 통과.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { StatusSource } from './status-sources.js';

const MAX_BYTES = 256 * 1024;
const INDICATORS = new Set(['none', 'minor', 'major', 'critical', 'maintenance']);

export interface VerifyDeps {
  resolve: (host: string) => Promise<string[]>;
  fetch: (url: string) => Promise<Response>;
}

export const resolvePublic: VerifyDeps['resolve'] = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

const defaultDeps: VerifyDeps = {
  resolve: resolvePublic,
  fetch: (url) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json', 'User-Agent': 'outage-map-status-check' } }),
};

/** 인터넷에서 닿는 주소인지 (사설·루프백·링크로컬·CGNAT·멀티캐스트·문서용 대역 거부) */
export function isPublicAddress(addr: string): boolean {
  if (isIP(addr) === 4) {
    const [a, b] = addr.split('.').map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (isIP(addr) === 6) {
    const v = addr.toLowerCase();
    if (v === '::' || v === '::1') return false;
    if (v.startsWith('::ffff:')) return isPublicAddress(v.slice(7));
    if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff') || v.startsWith('2001:db8')) return false;
    return true;
  }
  return false;
}

/** https · 443 · 계정 정보 없음 · IP 리터럴·내부 도메인 아님 · DNS가 전부 공개 주소로 풀림 */
export async function checkHost(url: URL, deps: Pick<VerifyDeps, 'resolve'>): Promise<boolean> {
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || /\.(?:local|internal|localhost|lan|home|corp)$/.test(host)) return false;
  try {
    const addrs = await deps.resolve(host);
    return addrs.length > 0 && addrs.every(isPublicAddress);
  } catch {
    return false;
  }
}

async function readLimited(res: Response): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface StatusReading {
  indicator: string;
  description: string;
  /** 리다이렉트를 따라간 뒤의 실제 API 주소 */
  apiUrl: string;
  pageUrl: string;
}

/** Statuspage 형식 상태 JSON을 안전하게 읽는다 (호스트 검사·리다이렉트 재검사·크기 상한·모양 검사). 아니면 null */
export async function readStatus(apiUrl: string, deps: VerifyDeps = defaultDeps): Promise<StatusReading | null> {
  let target: URL;
  try {
    target = new URL(apiUrl);
  } catch {
    return null;
  }
  if (target.pathname !== '/api/v2/status.json') return null;
  for (let hop = 0; hop <= 2; hop++) {
    if (!(await checkHost(target, deps))) return null;
    let res: Response;
    try {
      res = await deps.fetch(target.href);
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return null;
      target = new URL(loc, target);
      if (target.pathname !== '/api/v2/status.json') return null;
      continue;
    }
    if (!res.ok) return null;
    const text = await readLimited(res);
    if (!text) return null;
    let body: { page?: { name?: unknown; url?: unknown }; status?: { indicator?: unknown; description?: unknown } };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return null;
    }
    const indicator = body.status?.indicator;
    const description = body.status?.description;
    if (typeof body.page?.name !== 'string' || typeof indicator !== 'string' || !INDICATORS.has(indicator) || typeof description !== 'string') return null;
    const pageUrl = typeof body.page.url === 'string' && /^https?:\/\//.test(body.page.url) ? body.page.url.replace(/\/$/, '') : target.origin;
    return { indicator, description, apiUrl: target.href, pageUrl };
  }
  return null;
}

/** AI가 찾아 온 상태 페이지 주소(아무 경로) → 검증된 상태 API. 아니면 null */
export async function verifyStatusPage(candidate: string, deps: VerifyDeps = defaultDeps): Promise<StatusSource | null> {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  // origin을 쓰면 계정 정보가 빠지므로, 이상한 주소는 여기서 먼저 거른다
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const r = await readStatus(new URL('/api/v2/status.json', url.origin).href, deps);
  return r ? { pageUrl: r.pageUrl, apiUrl: r.apiUrl } : null;
}
