// 규칙은 정규식 대신 '*' 와일드카드 글롭만 쓴다. LLM이 만든 규칙도 저장하므로,
// 임의 정규식을 받지 않아서 ReDoS나 과도한 패턴을 원천적으로 막는다.

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string, caseInsensitive = false): RegExp {
  const key = `${caseInsensitive ? 'i' : 's'}:${glob}`;
  let re = cache.get(key);
  if (!re) {
    const body = glob
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    re = new RegExp(`^${body}$`, caseInsensitive ? 'i' : '');
    cache.set(key, re);
  }
  return re;
}

export function globMatch(glob: string | string[], value: string, caseInsensitive = false): boolean {
  const globs = Array.isArray(glob) ? glob : [glob];
  return globs.some((g) => globToRegExp(g, caseInsensitive).test(value));
}

/**
 * 환경변수·설정 키를 한 형태로 맞춘다. 언어마다 같은 설정을 다르게 쓰기 때문이다.
 *   PAYMENT_BASE_URL · payment.base-url · Payment:BaseUrl · Payment__BaseUrl → payment.base.url
 */
export function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1.$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}
