// 언어별 HTTP 클라이언트 지식. 공급자 규칙과 달리 "네트워크로 나가는 호출"을 찾는 용도라 코드로 둔다.
// q는 import 별칭을 풀어낸 호출식 이름이다 (resolve.ts의 qualify).

import type { CallFact, ValueFact } from './syntax.js';
import type { Lang } from './types.js';

export type HttpUse =
  /** 요청 한 번. viaInstance면 base는 인스턴스 쪽에 있다 */
  | { kind: 'request'; url?: ValueFact; viaInstance: boolean }
  /** 기준 주소를 가진 클라이언트 생성 (axios.create, httpx.Client, new HttpClient { BaseAddress }, @FeignClient) */
  | { kind: 'client'; base?: ValueFact }
  /** URL 객체 생성 (new URL, URI.create, new Uri) */
  | { kind: 'url'; url: ValueFact };

const last = (args: ValueFact[]) => args[args.length - 1];

export function classifyHttp(lang: Lang, q: string, call: CallFact, onInstance: boolean): HttpUse | null {
  const { args, options: o } = call;

  switch (lang) {
    case 'typescript':
    case 'tsx':
    case 'javascript': {
      if (call.isNew && q === 'URL' && args.length) return { kind: 'url', url: last(args)! };
      if (/^(?:(?:globalThis|window|self)\.)?fetch$|^\$fetch$|^(?:node-fetch|cross-fetch|isomorphic-fetch|ofetch|redaxios)$|^undici\.(?:fetch|request)$/.test(q)) {
        return { kind: 'request', url: args[0], viaInstance: false };
      }
      if (/^(?:axios|ky|got|ofetch|redaxios|superagent)(?:\.(?:get|post|put|patch|delete|head|options|request))?$/.test(q)) {
        return { kind: 'request', url: o.url ?? args[0], viaInstance: false };
      }
      if (/^(?:axios|ky|got|ofetch|\$fetch)\.(?:create|extend)$/.test(q)) return { kind: 'client', base: o.baseURL ?? o.prefixUrl ?? o.baseUrl };
      if (onInstance && /\.(?:get|post|put|patch|delete|head|options|request)$/.test(q)) return { kind: 'request', url: o.url ?? args[0], viaInstance: true };
      return null;
    }

    case 'python': {
      const m = /^(?:requests|httpx)\.(get|post|put|patch|delete|head|options|request|stream)$/.exec(q);
      if (m) return { kind: 'request', url: o.url ?? (m[1] === 'request' || m[1] === 'stream' ? args[1] : args[0]), viaInstance: false };
      if (/^urllib\.request\.(?:urlopen|Request)$/.test(q)) return { kind: 'request', url: args[0], viaInstance: false };
      if (/^(?:httpx\.(?:Async)?Client|requests\.Session|aiohttp\.ClientSession)$/.test(q)) return { kind: 'client', base: o.base_url ?? args[0] };
      const im = onInstance ? /\.(get|post|put|patch|delete|head|options|request|stream)$/.exec(q) : null;
      if (im) return { kind: 'request', url: o.url ?? (im[1] === 'request' || im[1] === 'stream' ? args[1] : args[0]), viaInstance: true };
      return null;
    }

    case 'java': {
      if ((call.isNew && /^(?:URL|URI)$/.test(q)) || q === 'URI.create') return args.length ? { kind: 'url', url: last(args)! } : null;
      if (/(?:^|\.)RestTemplate\.(?:getForObject|getForEntity|postForObject|postForEntity|postForLocation|put|patchForObject|delete|exchange|execute)$/.test(q)) {
        return { kind: 'request', url: args[0], viaInstance: false };
      }
      if (/WebClient.*\.uri$|HttpRequest.*\.uri$|HttpRequest\.newBuilder$|Request\.Builder\(\)(?:\.\w+\(\))*\.url$/.test(q)) {
        return { kind: 'request', url: args[0], viaInstance: true };
      }
      if (/WebClient\.create$/.test(q) || /(?:WebClient|RestClient).*\.baseUrl$/.test(q)) return { kind: 'client', base: args[0] };
      if (/(?:^|\.)FeignClient$/.test(q)) return { kind: 'client', base: o.url };
      return null;
    }

    case 'csharp': {
      if (call.isNew && q === 'Uri' && args.length) return { kind: 'url', url: args[0]! };
      if (call.isNew && q === 'HttpClient') return { kind: 'client', base: o.BaseAddress };
      if (call.isNew && /(?:^|\.)RestClient$/.test(q)) return { kind: 'client', base: args[0] };
      if (/(?:^|\.)HttpClient\.(?:GetAsync|PostAsync|PutAsync|PatchAsync|DeleteAsync|SendAsync|GetStringAsync|GetStreamAsync|GetByteArrayAsync|GetFromJsonAsync|PostAsJsonAsync|PutAsJsonAsync|PatchAsJsonAsync|DeleteFromJsonAsync)$/.test(q)) {
        return { kind: 'request', url: args[0], viaInstance: true };
      }
      return null;
    }
  }
}

/** 선언 타입만 보고 HTTP 클라이언트 인스턴스인지 (주입된 HttpClient, RestTemplate 등) */
export function isHttpClientType(lang: Lang, qualifiedType: string): boolean {
  if (lang === 'csharp') return /(?:^|\.)HttpClient$/.test(qualifiedType);
  if (lang === 'java') return /(?:^|\.)(?:RestTemplate|WebClient|RestClient)$/.test(qualifiedType);
  if (lang === 'python') return /^(?:httpx\.(?:Async)?Client|requests\.Session|aiohttp\.ClientSession)$/.test(qualifiedType);
  return /^(?:axios\.AxiosInstance|ky\.KyInstance|got\.Got)$/.test(qualifiedType);
}

/** 코드 사실: 호출부를 감싼 함수 안에서 찾는다 */
export const RETRY_RE = /\bretr(?:y|ies|ying)\b|backoff|@Retryable|\btenacity\b|WaitAndRetry|AddStandardResilienceHandler|AddPolicyHandler|axios-retry|p-retry|\bmaxAttempts\b/i;
export const TIMEOUT_RE = /AbortSignal\.timeout|\bsignal\s*[:=]|\btimeout\s*[:=]|\.timeout\s*\(|\bTimeout\s*=|setConnectTimeout|setReadTimeout|connectTimeout|readTimeout|CancellationToken|asyncio\.wait_for/i;
export const STATUS_RE = /\.ok\b|\.status\b|\bstatus_code\b|\bstatusCode\b|raise_for_status|IsSuccessStatusCode|EnsureSuccessStatusCode|getStatusCode|is2xxSuccessful|onStatus\s*\(|validateStatus/;
export const ASYNC_CATCH_RE = /\.catch\s*\(|\.exceptionally\s*\(|onErrorResume|onErrorReturn/;
