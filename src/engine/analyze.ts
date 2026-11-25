// 저장소 파일 묶음 → 공급자 근거·파일 상태·애매 후보.
//   ① 경로 분류 ② 텍스트 단서 ③ 1-hop 보강 ④ 파싱·사실 추출 ⑤ 해석(2회: 직접 → 1-hop) ⑥ 정리

import { globMatch } from './glob.js';
import { classifyPath, extractScriptBlocks, skipReason } from './files.js';
import { csharpHooks } from './lang/csharp.js';
import { javaHooks } from './lang/java.js';
import { jsHooks } from './lang/js.js';
import { pythonHooks } from './lang/python.js';
import { mentionsAny, resolveModulePath, scanImportSpecifiers, TEXT_SIGNAL } from './locate.js';
import { endpointOf, looksLikeUrl, resolveFile, resolveUrlPattern, type CrossFile, type FileResolution, type RawAmbiguous } from './resolve.js';
import { BUILTIN_RULES, COMMON_DEPENDENCIES, rulesetVersion, type Rule, type RuleMatch } from './rules.js';
import { parseConfig, parseManifest, type Dependency, type SettingEntry } from './settings.js';
import { extractFacts, getParser, type FileFacts, type Hooks } from './syntax.js';
import type { AmbiguousItem, EngineResult, Evidence, FileStatus, Lang, ProviderId, RepoFile } from './types.js';

export interface AnalyzeOptions {
  rules?: Rule[];
  /** false면 텍스트 단서와 상관없이 모든 소스를 파싱한다 (검증·디버깅용) */
  prefilter?: boolean;
}

interface Source {
  path: string;
  lang: Lang;
  /** 파싱할 텍스트 (Svelte·Vue는 스크립트만 남김) */
  text: string;
  original: string;
}

const HOOKS: Record<Lang, Hooks> = {
  typescript: jsHooks('typescript'),
  tsx: jsHooks('tsx'),
  javascript: jsHooks('javascript'),
  python: pythonHooks,
  java: javaHooks,
  csharp: csharpHooks,
};

export async function analyze(files: RepoFile[], options: AnalyzeOptions = {}): Promise<EngineResult> {
  const rules = options.rules ?? BUILTIN_RULES;
  const statuses = new Map<string, FileStatus>();
  const texts = new Map<string, string>();
  const deps: Dependency[] = [];
  const settings: SettingEntry[] = [];
  const sources: Source[] = [];

  // ① 경로 분류 + 매니페스트·설정
  for (const f of files) {
    const role = classifyPath(f.path);
    if (role.kind === 'ignored') continue;
    if (role.kind === 'other') {
      statuses.set(f.path, { path: f.path, state: 'other' });
    } else if (role.kind === 'manifest') {
      deps.push(...parseManifest(role, f.path, f.content));
      statuses.set(f.path, { path: f.path, state: 'analyzed' });
      texts.set(f.path, f.content);
    } else if (role.kind === 'config') {
      settings.push(...parseConfig(role, f.path, f.content));
      statuses.set(f.path, { path: f.path, state: 'analyzed' });
      texts.set(f.path, f.content);
    } else {
      const skip = skipReason(f.path, f.content);
      if (skip) {
        statuses.set(f.path, { path: f.path, state: 'skipped', reason: skip });
        continue;
      }
      statuses.set(f.path, { path: f.path, state: 'analyzed', lang: role.lang });
      sources.push({ path: f.path, lang: role.lang, text: role.embedded ? extractScriptBlocks(f.content) : f.content, original: f.content });
    }
  }

  const settingTable = new Map<string, SettingEntry[]>();
  for (const e of settings) settingTable.set(e.normalized, [...(settingTable.get(e.normalized) ?? []), e]);
  const ctx = { rules, settings: settingTable };
  const sourcePaths = new Set(sources.map((s) => s.path));

  // ④ 파싱 (파일 단위, 실패해도 다른 파일은 계속)
  const parsed = new Map<string, FileFacts>();
  const parse = async (s: Source) => {
    if (parsed.has(s.path)) return;
    try {
      const parser = await getParser(s.lang);
      const tree = parser.parse(s.text);
      if (!tree) throw new Error('parse returned null');
      try {
        parsed.set(s.path, extractFacts(tree.rootNode, HOOKS[s.lang], s.text));
      } finally {
        tree.delete();
      }
      texts.set(s.path, s.original);
    } catch {
      statuses.set(s.path, { path: s.path, state: 'skipped', reason: 'parse-error' });
    }
  };

  const resolveAll = (cross: CrossFile | null) => {
    const out = new Map<string, FileResolution>();
    for (const [path, facts] of parsed) out.set(path, resolveFile(path, facts, ctx, cross));
    return out;
  };

  // ② 텍스트 단서
  const prefilter = options.prefilter !== false;
  for (const s of sources) if (!prefilter || TEXT_SIGNAL.test(s.text)) await parse(s);

  // ⑤-1 직접 해석: 공급자 흔적이 있는 파일과 그 파일의 이름·클래스
  let direct = resolveAll(null);

  // ③ 1-hop 보강: 공급자 파일을 import 경로나 클래스 이름으로 참조하는 파일도 파싱
  if (prefilter) {
    const providerPaths = new Set([...direct].filter(([, r]) => r.providers.size).map(([p]) => p));
    const providerClasses = new Set([...providerPaths].flatMap((p) => parsed.get(p)!.classes));
    const extra = sources.filter(
      (s) =>
        !parsed.has(s.path) &&
        (scanImportSpecifiers(s.text, s.lang).some((spec) => {
          const target = resolveModulePath(s.path, spec, s.lang, sourcePaths);
          return target !== null && providerPaths.has(target);
        }) ||
          mentionsAny(s.text, providerClasses)),
    );
    for (const s of extra) await parse(s);
    if (extra.length) direct = resolveAll(null);
  }

  // ⑤-2 1-hop 해석
  const exportsByPath = new Map([...direct].map(([p, r]) => [p, r.exports]));
  const classProviders = new Map<string, Set<ProviderId>>();
  for (const [p, r] of direct) if (r.providers.size) for (const c of parsed.get(p)!.classes) classProviders.set(c, r.providers);
  const union = (sets: Iterable<Set<ProviderId>>) => new Set([...sets].flatMap((s) => [...s]));
  const cross: CrossFile = {
    classProviders,
    localImport(from, module, imported, lang) {
      const target = resolveModulePath(from, module, lang, sourcePaths);
      if (target) {
        const ex = exportsByPath.get(target);
        if (!ex) return new Set();
        if (imported === '*') return union(ex.values());
        const hit = ex.get(imported);
        if (hit) return hit;
      }
      // from app.lib import stripe_client: 이름이 하위 모듈인 경우
      if (lang === 'python' && imported !== '*') {
        const sub = resolveModulePath(from, module.endsWith('.') ? module + imported : `${module}.${imported}`, lang, sourcePaths);
        if (sub) return union(exportsByPath.get(sub)?.values() ?? []);
      }
      return target ? new Set() : null;
    },
  };
  const final = resolveAll(cross);

  // ⑥ 정리: 코드 근거 + 매니페스트·설정 근거 + 애매 후보
  const evidence: Evidence[] = [...final.values()].flatMap((r) => r.evidence);
  const raw: (RawAmbiguous | { kind: 'dependency'; dep: Dependency })[] = [...final.values()].flatMap((r) => r.ambiguous);

  const depRules = rules.filter((r): r is Rule & { match: Extract<RuleMatch, { type: 'dependency' }> } => r.match.type === 'dependency');
  for (const d of deps) {
    const hits = depRules.filter((r) => r.match.ecosystem === d.ecosystem && globMatch(r.match.name, d.name, true));
    for (const r of hits) evidence.push({ provider: r.provider, path: d.path, line: d.line, kind: 'manifest', detail: d.name, ruleId: r.id });
    if (!hits.length && !globMatch(COMMON_DEPENDENCIES[d.ecosystem], d.name, true)) raw.push({ kind: 'dependency', dep: d });
  }

  const settingRules = rules.filter((r): r is Rule & { match: Extract<RuleMatch, { type: 'setting' }> } => r.match.type === 'setting');
  for (const e of settings) {
    for (const r of settingRules) {
      if (globMatch(r.match.key, e.normalized)) evidence.push({ provider: r.provider, path: e.path, line: e.line, kind: 'config', detail: `${e.key} 설정`, ruleId: r.id });
    }
    if (!looksLikeUrl(e.value)) continue;
    const o = resolveUrlPattern(e.value, rules);
    if (o?.type === 'provider') {
      const endpoint = endpointOf(o);
      evidence.push({ provider: o.provider, path: e.path, line: e.line, kind: 'config', detail: `${e.key} → ${o.label}`, ruleId: o.ruleId, ...(endpoint ? { endpoint } : {}) });
    }
    else if (o?.type === 'external') raw.push({ kind: 'host', host: o.host, loc: { path: e.path, line: e.line } });
  }

  return {
    evidence: dedupeEvidence(evidence),
    files: [...statuses.values()].sort((a, b) => a.path.localeCompare(b.path)),
    ambiguous: groupAmbiguous(raw),
    texts,
    stats: {
      files: statuses.size,
      analyzed: [...statuses.values()].filter((s) => s.state === 'analyzed').length,
      skipped: [...statuses.values()].filter((s) => s.state === 'skipped').length,
      sourceChars: sources.reduce((n, s) => n + s.text.length, 0),
      parsedFiles: parsed.size,
      rulesetVersion: rulesetVersion(rules),
    },
  };
}

function dedupeEvidence(list: Evidence[]): Evidence[] {
  const seen = new Map<string, Evidence>();
  for (const e of list) {
    const key = `${e.provider}|${e.path}|${e.line}|${e.kind}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  return [...seen.values()];
}

/** 같은 호출·host·의존성은 하나로 묶고 위치만 모은다. LLM에는 위치를 보내지 않는다. */
function groupAmbiguous(raw: (RawAmbiguous | { kind: 'dependency'; dep: Dependency })[]): AmbiguousItem[] {
  const items = new Map<string, AmbiguousItem>();
  const counters = { http: 0, host: 0, dependency: 0 };
  const prefix = { http: 'h', host: 'u', dependency: 'd' } as const;
  for (const r of raw) {
    const key =
      r.kind === 'http' ? `http|${r.call}|${r.hint ?? ''}` : r.kind === 'host' ? `host|${r.host}` : `dep|${r.dep.ecosystem}|${r.dep.name}`;
    const loc = r.kind === 'dependency' ? { path: r.dep.path, line: r.dep.line } : r.loc;
    const existing = items.get(key);
    if (existing) {
      existing.occurrences.push(loc);
      continue;
    }
    const id = `${prefix[r.kind]}${++counters[r.kind]}`;
    items.set(
      key,
      r.kind === 'http'
        ? { id, kind: 'http', call: r.call, ...(r.hint ? { hint: r.hint } : {}), lang: r.lang, occurrences: [loc] }
        : r.kind === 'host'
          ? { id, kind: 'host', host: r.host, occurrences: [loc] }
          : { id, kind: 'dependency', ecosystem: r.dep.ecosystem, name: r.dep.name, occurrences: [loc] },
    );
  }
  return [...items.values()];
}
