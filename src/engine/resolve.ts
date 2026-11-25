// 파일 하나의 FileFacts를 규칙과 맞춰 근거(Evidence)와 애매 후보를 만든다.
//   1) import → 이름 바인딩 (별칭을 풀어낸 이름 + 공급자)
//   2) 선언 → 바인딩 전파 (const s3 = new S3Client(), 주입된 타입, 함수가 참조하는 클라이언트)
//   3) 호출 → 규칙 매칭, HTTP 호출이면 URL을 끝까지 풀기 (변수 → 설정 키 → 설정 파일 값)
//   4) 설정 읽기·문자열 → 공급자 단서

import { globMatch, normalizeKey } from './glob.js';
import { ASYNC_CATCH_RE, classifyHttp, isHttpClientType, RETRY_RE, STATUS_RE, TIMEOUT_RE } from './http.js';
import { KNOWN_SERVICES, type Rule, type RuleMatch } from './rules.js';
import type { SettingEntry } from './settings.js';
import { DYN, type CallFact, type DeclFact, type FileFacts, type ValueFact } from './syntax.js';
import type { CodeFacts, Evidence, Lang, Location, ProviderId } from './types.js';

export type Outcome =
  /** host: host 규칙으로 판정했을 때만 있다 (설정 키로 판정하면 실제 host를 모름) */
  | { type: 'provider'; provider: ProviderId; label: string; host?: string; path?: string; ruleId: string }
  | { type: 'internal' }
  | { type: 'relative'; path: string }
  | { type: 'external'; host: string }
  | { type: 'unresolved'; hint?: string };

export interface ResolveContext {
  rules: Rule[];
  /** normalizeKey(설정 키) → 설정 파일 항목 */
  settings: Map<string, SettingEntry[]>;
}

export interface CrossFile {
  /** 저장소 안 모듈을 import했을 때 그 이름이 가진 공급자. 저장소 밖 모듈이면 null */
  localImport(fromPath: string, module: string, imported: string, lang: Lang): Set<ProviderId> | null;
  /** 공급자 흔적이 있는 파일에 선언된 클래스 → 공급자 (Java·C#·TS 주입) */
  classProviders: Map<string, Set<ProviderId>>;
}

export type RawAmbiguous =
  | { kind: 'http'; call: string; hint?: string; lang: Lang; loc: Location }
  | { kind: 'host'; host: string; loc: Location };

export interface FileResolution {
  evidence: Evidence[];
  ambiguous: RawAmbiguous[];
  /** 다른 파일이 import할 수 있는 이름 → 공급자 */
  exports: Map<string, Set<ProviderId>>;
  providers: Set<ProviderId>;
}

interface Binding {
  qualified: string;
  providers: Set<ProviderId>;
  /**
   * false면 공급자가 함수 본문 등에서 참조한 이름으로만 전파된 것 (checkEnv()가 안에서 stripe를 쓰는 경우).
   * 이런 이름은 다른 파일로 넘길 때(1-hop)만 쓰고, 같은 파일의 호출 근거로는 세지 않는다.
   */
  direct: boolean;
  /** HTTP 클라이언트 인스턴스면 기준 주소 */
  http?: { base?: ValueFact };
}

type RuleOf<T extends RuleMatch['type']> = Rule & { match: Extract<RuleMatch, { type: T }> };
const rulesOf = <T extends RuleMatch['type']>(rules: Rule[], type: T) => rules.filter((r): r is RuleOf<T> => r.match.type === type);

// ─── URL 패턴 ───────────────────────────────────────────────────────────────

const PLACEHOLDER = 'dyn0x';
const SCHEME_URL = /^(?:(?:https?|wss?):)?\/\/|^(?:jdbc:)?(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\//i;

function isInternalHost(host: string): boolean {
  return (
    !host.includes('.') ||
    /^(?:localhost|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?)$/.test(host) ||
    /\.(?:local|internal|localhost|svc|cluster\.local)$/.test(host) ||
    host === 'host.docker.internal'
  );
}

function pathOf(rest: string): string | undefined {
  if (!rest.startsWith('/')) return undefined;
  return rest.split(/[?#]/)[0]!.split(DYN).join('*');
}

/** 리터럴 패턴(동적인 부분은 DYN)을 host 규칙과 맞춘다. 앞부분이 동적이면 null */
export function resolveUrlPattern(raw: string, rules: Rule[]): Outcome | null {
  const s = raw.split(DYN).join(PLACEHOLDER).trim();
  if (!s || s.startsWith(PLACEHOLDER)) return null;
  if (SCHEME_URL.test(s)) {
    let url: URL;
    try {
      url = new URL(s.startsWith('//') ? `https:${s}` : s.replace(/^jdbc:/i, ''));
    } catch {
      return { type: 'unresolved', hint: raw.split(DYN).join('…') };
    }
    const host = url.hostname.toLowerCase();
    if (!host || host === PLACEHOLDER) return null;
    const display = host.split(PLACEHOLDER).join('*');
    if (isInternalHost(host)) return { type: 'internal' };
    const path = pathOf(decodeURIComponent(url.pathname).split(PLACEHOLDER).join(DYN));
    for (const r of rulesOf(rules, 'host')) {
      if (globMatch(r.match.host, host)) return { type: 'provider', provider: r.provider, label: display, host: display, ...(path ? { path } : {}), ruleId: r.id };
    }
    return { type: 'external', host: display };
  }
  if (/^[a-z][\w+.-]*:/i.test(s)) return { type: 'internal' }; // mailto:, data:, file: …
  return { type: 'relative', path: raw };
}

/** 스킴 없는 host 문자열 (next.config의 images.remotePatterns 등) */
function resolveBareHost(value: string, rules: Rule[]): Outcome | null {
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(value)) return null;
  for (const r of rulesOf(rules, 'host')) {
    if (globMatch(r.match.host, value.toLowerCase())) return { type: 'provider', provider: r.provider, label: value.toLowerCase(), host: value.toLowerCase(), ruleId: r.id };
  }
  return null;
}

export const looksLikeUrl = (v: string) => SCHEME_URL.test(v.trim());

export function endpointOf(o: Outcome): Evidence['endpoint'] {
  if (o.type !== 'provider' || !o.host) return undefined;
  return o.path ? { host: o.host, path: o.path } : { host: o.host };
}

function pick(outs: Outcome[]): Outcome {
  for (const type of ['provider', 'external', 'unresolved', 'relative', 'internal'] as const) {
    const o = outs.find((x) => x.type === type);
    if (o) return o;
  }
  return { type: 'unresolved' };
}

export function roleFor(provider: ProviderId, callee: string, qualified: string, path?: string): string | undefined {
  for (const r of KNOWN_SERVICES[provider]?.roles ?? []) {
    if (r.callee && callee && (globMatch(r.callee, callee) || globMatch(r.callee, qualified))) return r.role;
    if (r.path && path && globMatch(r.path, path)) return r.role;
  }
  return undefined;
}

// ─── 파일 해석 ──────────────────────────────────────────────────────────────

export function resolveFile(path: string, facts: FileFacts, ctx: ResolveContext, cross: CrossFile | null): FileResolution {
  const lang = facts.lang;
  const rules = ctx.rules.filter((r) => !r.langs || r.langs.includes(lang));
  const importRules = rulesOf(rules, 'import');
  const callRules = rulesOf(rules, 'call');
  const typeRules = rulesOf(rules, 'type');
  const settingRules = rulesOf(rules, 'setting');
  const importedModules = facts.imports.map((i) => i.module);
  const importOk = (w?: string | string[]) => !w || importedModules.some((m) => globMatch(w, m));
  const lines = facts.code.split('\n');

  const evidence: Evidence[] = [];
  const ambiguous: RawAmbiguous[] = [];
  const add = (provider: ProviderId, line: number, kind: Evidence['kind'], detail: string, extra: Partial<Evidence> = {}) => {
    const clean = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined));
    evidence.push({ provider, path, line, kind, detail, ...clean });
  };
  const bindings = new Map<string, Binding>();

  // 1) import
  for (const imp of facts.imports) {
    const fromRules = new Map<ProviderId, string>();
    for (const r of importRules) if (globMatch(r.match.module, imp.module)) fromRules.set(r.provider, r.id);
    const viaLocal = new Set<ProviderId>();
    for (const b of imp.bindings) {
      const qualified = b.imported === 'default' || b.imported === '*' ? imp.module : `${imp.module}.${b.imported}`;
      const providers = new Set(fromRules.keys());
      cross?.localImport(path, imp.module, b.imported, lang)?.forEach((p) => {
        providers.add(p);
        viaLocal.add(p);
      });
      bindings.set(b.local, { qualified, providers, direct: true });
    }
    if (!imp.bindings.length) cross?.localImport(path, imp.module, '*', lang)?.forEach((p) => viaLocal.add(p));
    // import type은 바인딩만 만들고 근거로는 세지 않는다
    if (imp.typeOnly) continue;
    for (const [p, id] of fromRules) add(p, imp.line, 'import', imp.module, { ruleId: id });
    for (const p of viaLocal) if (!fromRules.has(p)) add(p, imp.line, 'import', imp.module);
  }

  const qualify = (callee: string): { qualified: string; binding?: Binding } => {
    const stripped = callee.replace(/^(?:this|self|cls)\./, '');
    const m = /^([^.()[\]]+)(.*)$/.exec(stripped);
    if (!m) return { qualified: stripped };
    const binding = bindings.get(m[1]!);
    return { qualified: binding ? binding.qualified + m[2] : stripped, ...(binding ? { binding } : {}) };
  };

  const callProviders = (call: CallFact, q: string, binding?: Binding) => {
    const out = new Map<ProviderId, string | undefined>();
    if (binding?.direct) binding.providers.forEach((p) => out.set(p, undefined));
    for (const r of callRules) {
      const m = r.match;
      if (!globMatch(m.callee, q)) continue;
      if (m.arg0 !== undefined && call.args[0]?.pattern !== m.arg0) continue;
      if (!importOk(m.whenImport)) continue;
      out.set(r.provider, r.id);
    }
    if (call.isNew) cross?.classProviders.get(q)?.forEach((p) => out.has(p) || out.set(p, undefined));
    return out;
  };

  const typeInfo = (type: string) => {
    const r = qualify(type);
    const providers = new Map<ProviderId, string | undefined>();
    if (r.binding?.direct) r.binding.providers.forEach((p) => providers.set(p, undefined));
    for (const rule of typeRules) {
      if ((globMatch(rule.match.name, type) || globMatch(rule.match.name, r.qualified)) && importOk(rule.match.whenImport)) providers.set(rule.provider, rule.id);
    }
    cross?.classProviders.get(type)?.forEach((p) => providers.has(p) || providers.set(p, undefined));
    return { qualified: r.qualified, providers };
  };

  const declByName = new Map<string, DeclFact>();
  for (const d of facts.decls) if (d.value) declByName.set(d.name, d);

  const resolveSetting = (key: string): Outcome => {
    const norm = normalizeKey(key);
    for (const r of settingRules) {
      if (globMatch(r.match.key, norm)) return { type: 'provider', provider: r.provider, label: `${key} 설정 주소`, ruleId: r.id };
    }
    const entry = ctx.settings.get(norm)?.find((e) => looksLikeUrl(e.value));
    if (entry) {
      const o = resolveUrlPattern(entry.value, ctx.rules);
      if (o && o.type !== 'relative') return o;
    }
    return { type: 'unresolved', hint: `설정 ${key}${entry ? '' : ' (값 없음)'}` };
  };

  const resolveValue = (v: ValueFact | undefined, depth = 0): Outcome => {
    if (!v || depth > 5) return { type: 'unresolved', ...(v ? { hint: v.text } : {}) };
    if (v.alts) return pick(v.alts.map((a) => resolveValue(a, depth + 1)));
    if (v.pattern !== undefined) {
      const o = resolveUrlPattern(v.pattern, ctx.rules);
      if (o) return o;
      if (!v.head) return { type: 'unresolved', hint: v.text };
      const head = resolveValue(v.head, depth + 1);
      const rest = v.pattern.slice(1);
      if (head.type === 'provider') {
        const p = head.path ?? pathOf(rest);
        return p ? { ...head, path: p } : head;
      }
      if (head.type === 'relative') return { type: 'relative', path: head.path + rest };
      if (head.type === 'unresolved') return { type: 'unresolved', hint: head.hint ?? v.head.text };
      return head;
    }
    if (v.setting) return resolveSetting(v.setting);
    if (v.ident) {
      const d = declByName.get(v.ident);
      if (d?.value && d.value !== v) {
        const o = resolveValue(d.value, depth + 1);
        if (o.type !== 'unresolved') return o;
        return { type: 'unresolved', hint: o.hint && o.hint !== d.value.text ? o.hint : `${v.ident} = ${d.value.text}` };
      }
      return { type: 'unresolved', hint: v.ident };
    }
    return { type: 'unresolved', hint: v.text };
  };

  // 2) 선언 → 바인딩 전파 (서로 참조할 수 있어서 바뀌지 않을 때까지 최대 3번)
  for (let iter = 0; iter < 3; iter++) {
    let changed = false;
    for (const d of facts.decls) {
      const providers = new Set<ProviderId>();
      let qualified: string | undefined;
      let http: Binding['http'];
      if (d.type) {
        const t = typeInfo(d.type);
        qualified = t.qualified;
        t.providers.forEach((_, p) => providers.add(p));
        if (isHttpClientType(lang, t.qualified)) http = {};
      }
      if (d.initCall !== undefined) {
        const call = facts.calls[d.initCall]!;
        const r = qualify(call.callee);
        // 선언 타입이 있으면 그 타입을, new X()면 X의 인스턴스를, 팩토리 호출이면 X()의 결과를 이름으로 쓴다
        qualified ??= call.isNew ? r.qualified : `${r.qualified}()`;
        callProviders(call, r.qualified, r.binding).forEach((_, p) => providers.add(p));
        const use = classifyHttp(lang, r.qualified, call, !!r.binding?.http);
        if (use?.kind === 'client') {
          http = use.base ? { base: use.base } : {};
          const o = use.base ? resolveValue(use.base) : null;
          if (o?.type === 'provider') providers.add(o.provider);
        } else if (r.binding?.http && /(?:build|create)\(\)$/.test(qualified)) http = r.binding.http;
      } else if (d.value?.ident && d.value.ident !== d.name) {
        const b = bindings.get(d.value.ident);
        if (b?.direct) {
          qualified ??= b.qualified;
          b.providers.forEach((p) => providers.add(p));
          http ??= b.http;
        }
      }
      const direct = providers.size > 0 || !!http;
      for (const ref of d.refs) if (ref !== d.name) bindings.get(ref)?.providers.forEach((p) => providers.add(p));

      const cur = bindings.get(d.name);
      if (!cur) {
        if (qualified || providers.size || http) {
          bindings.set(d.name, { qualified: qualified ?? d.name, providers, direct, ...(http ? { http } : {}) });
          changed = true;
        }
      } else {
        if (direct && !cur.direct) {
          cur.direct = true;
          changed = true;
        }
        for (const p of providers) {
          if (!cur.providers.has(p)) {
            cur.providers.add(p);
            changed = true;
          }
        }
        if (!cur.http && http) {
          cur.http = http;
          changed = true;
        }
        if (qualified && cur.qualified === d.name) cur.qualified = qualified;
      }
    }
    if (!changed) break;
  }

  // 주입된 필드·매개변수 타입 (private final S3Client s3; constructor(private stripe: StripeService))
  for (const d of facts.decls) {
    if ((d.kind !== 'field' && d.kind !== 'param') || !d.type) continue;
    for (const [p, id] of typeInfo(d.type).providers) add(p, d.line, 'type', d.type, { ruleId: id });
  }

  const codeFacts = (call: CallFact): CodeFacts => {
    const scope = facts.scopes[call.scope]!;
    const text = lines.slice(scope.start - 1, scope.end).join('\n');
    return {
      errorHandling: call.inTry || ASYNC_CATCH_RE.test(text),
      retry: RETRY_RE.test(text),
      timeout: 'timeout' in call.options || 'signal' in call.options || TIMEOUT_RE.test(text),
      statusCheck: STATUS_RE.test(text),
    };
  };

  const resolveRequest = (url: ValueFact | undefined, viaInstance: boolean, http?: Binding['http']): Outcome | null => {
    if (!url) return http?.base ? resolveValue(http.base) : null;
    const o = resolveValue(url);
    if (o.type !== 'relative') return o;
    if (!viaInstance) return { type: 'internal' };
    // 기준 주소를 모르는 인스턴스(주입된 HttpClient 등): 인스턴스를 만드는 쪽에서 이미 다룬다
    if (!http?.base) return null;
    const base = resolveValue(http.base);
    if (base.type !== 'provider') return null;
    const p = base.path ?? pathOf(o.path);
    return p ? { ...base, path: p } : base;
  };

  // 3) 호출
  for (const call of facts.calls) {
    const r = qualify(call.callee);
    const providers = callProviders(call, r.qualified, r.binding);
    const use = classifyHttp(lang, r.qualified, call, !!r.binding?.http);
    let o: Outcome | null = null;
    if (use?.kind === 'request') o = resolveRequest(use.url, use.viaInstance, r.binding?.http);
    else if (use?.kind === 'client') o = use.base ? resolveValue(use.base) : null;
    else if (use?.kind === 'url') o = resolveValue(use.url);

    const urlPath = o?.type === 'provider' ? o.path : undefined;
    const callee = call.callee.replace(/^(?:this|self)\./, '');
    const cf = providers.size || use?.kind === 'request' ? codeFacts(call) : undefined;
    for (const [p, id] of providers) add(p, call.line, 'call', callee, { ruleId: id, facts: cf, role: roleFor(p, call.callee, r.qualified, urlPath), setup: call.isNew || undefined });

    if (!o || !use) continue;
    const loc = { path, line: call.line };
    if (o.type === 'provider' && !providers.has(o.provider)) {
      add(o.provider, call.line, use.kind === 'url' ? 'url' : 'http', o.label, {
        ruleId: o.ruleId,
        facts: use.kind === 'url' ? undefined : (cf ?? codeFacts(call)),
        role: roleFor(o.provider, call.callee, r.qualified, o.path),
        endpoint: endpointOf(o),
      });
    } else if (o.type === 'external' && use.kind !== 'url') ambiguous.push({ kind: 'host', host: o.host, loc });
    else if (o.type === 'unresolved' && use.kind !== 'url') ambiguous.push({ kind: 'http', call: call.text, ...(o.hint ? { hint: o.hint } : {}), lang, loc });
  }

  // 4) 설정 읽기 · 문자열
  for (const s of facts.settings) {
    const norm = normalizeKey(s.key);
    for (const r of settingRules) if (globMatch(r.match.key, norm)) add(r.provider, s.line, 'setting', s.key, { ruleId: r.id });
  }
  for (const s of facts.strings) {
    const o = looksLikeUrl(s.value) ? resolveUrlPattern(s.value, ctx.rules) : resolveBareHost(s.value, ctx.rules);
    if (o?.type === 'provider') add(o.provider, s.line, 'url', o.label, { ruleId: o.ruleId, role: roleFor(o.provider, '', '', o.path), endpoint: endpointOf(o) });
  }

  // 다른 파일에 넘길 이름
  const exports = new Map<string, Set<ProviderId>>();
  const jsLike = lang === 'typescript' || lang === 'tsx' || lang === 'javascript';
  for (const d of facts.decls) {
    const b = bindings.get(d.name);
    if (b?.providers.size && (!jsLike || d.exported)) exports.set(d.name, b.providers);
  }
  for (const a of facts.exportAliases) {
    const b = bindings.get(a.local);
    if (b?.providers.size) exports.set(a.exported, b.providers);
  }

  return { evidence, ambiguous, exports, providers: new Set(evidence.map((e) => e.provider)) };
}
