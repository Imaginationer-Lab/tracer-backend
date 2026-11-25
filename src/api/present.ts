// 엔진 결과 → HTTP 응답 모양 (docs/api.md)

import { categoryOf, PROVIDER_IDS, PROVIDERS } from '../engine/rules.js';
import type { EngineResult, Evidence } from '../engine/types.js';
import type { AnalysisResult, EvidenceItem, FileEntry, ProviderDetail, ProviderId, ProviderSummary } from './contract.js';

const PRIORITY: Record<Evidence['kind'], number> = {
  call: 9,
  http: 9,
  url: 6,
  type: 5,
  import: 5,
  setting: 4,
  config: 3,
  llm: 3,
  manifest: 1,
};
/** 코드가 아니라 선언·설정에서 나온 근거 */
const DECLARATIVE = new Set<Evidence['kind']>(['manifest', 'config']);
const MAX_PATHS = 5000;

/** 우선순위가 같으면 클라이언트 생성보다 실제 호출, 그다음 위쪽 줄 */
const better = (a: Evidence, b: Evidence) =>
  PRIORITY[a.kind] !== PRIORITY[b.kind] ? PRIORITY[a.kind] > PRIORITY[b.kind] : !!a.setup !== !!b.setup ? !a.setup : a.line < b.line;

/** 공급자·파일마다 가장 강한 근거 하나 */
function bestByFile(evidence: Evidence[]): Map<string, Evidence> {
  const out = new Map<string, Evidence>();
  for (const e of evidence) {
    const cur = out.get(e.path);
    if (!cur || better(e, cur)) out.set(e.path, e);
  }
  return out;
}

function evidenceFor(r: EngineResult, provider: ProviderId) {
  const all = r.evidence.filter((e) => e.provider === provider);
  const used = all.some((e) => !DECLARATIVE.has(e.kind));
  // 코드 근거가 있으면 매니페스트·설정 파일은 파일 수에서 뺀다
  return { used, list: used ? all.filter((e) => !DECLARATIVE.has(e.kind)) : all };
}

export function toAnalysisResult(r: EngineResult): AnalysisResult {
  const providers: ProviderSummary[] = [];
  for (const id of PROVIDER_IDS) {
    const { used, list } = evidenceFor(r, id);
    if (!list.length) continue;
    const roles = new Map<string, number>();
    for (const e of list) if (e.role) roles.set(e.role, (roles.get(e.role) ?? 0) + 1);
    const role = [...roles].sort((a, b) => b[1] - a[1])[0]?.[0] ?? PROVIDERS[id].defaultRole;
    const files = [...bestByFile(list).values()]
      .sort((a, b) => PRIORITY[b.kind] - PRIORITY[a.kind] || a.path.localeCompare(b.path))
      .map((e) => ({ path: e.path, line: e.line }));
    providers.push({
      id,
      name: PROVIDERS[id].name,
      role,
      category: categoryOf(id, role),
      fileCount: files.length,
      files,
      usage: used ? 'used' : 'declared-only',
      statusSupport: PROVIDERS[id].statusApi ? 'live' : 'none',
    });
  }

  const matches = new Map<string, { provider: ProviderId; line: number }[]>();
  for (const id of PROVIDER_IDS) {
    for (const [path, e] of bestByFile(evidenceFor(r, id).list)) {
      matches.set(path, [...(matches.get(path) ?? []), { provider: id, line: e.line }]);
    }
  }

  let statuses = r.files;
  if (statuses.length > MAX_PATHS) statuses = statuses.filter((f) => f.state !== 'other');
  const files: FileEntry[] = statuses.map((f) =>
    f.state === 'analyzed'
      ? { path: f.path, state: 'analyzed', matches: matches.get(f.path) ?? [] }
      : f.state === 'skipped'
        ? { path: f.path, state: 'skipped', reason: f.reason ?? 'parse-error' }
        : { path: f.path, state: 'other' },
  );

  return { providers, files, summary: { analyzed: r.stats.analyzed, skipped: r.stats.skipped } };
}

export function toProviderDetail(r: EngineResult, provider: ProviderId): ProviderDetail {
  const info = PROVIDERS[provider];
  const best = [...bestByFile(evidenceFor(r, provider).list).values()].sort(
    (a, b) => PRIORITY[b.kind] - PRIORITY[a.kind] || a.path.localeCompare(b.path),
  );
  const langByPath = new Map(r.files.map((f) => [f.path, f.lang]));
  const evidence: EvidenceItem[] = best.map((e) => {
    const lines = (r.texts.get(e.path) ?? '').split('\n');
    const start = Math.max(1, e.line - 1);
    return {
      path: e.path,
      line: e.line,
      language: langByPath.get(e.path) ?? languageOf(e.path),
      reason: { kind: e.kind, label: evidenceLabel(e) },
      snippet: { startLine: start, lines: lines.slice(start - 1, start + 4).map((l) => l.replace(/\r$/, '')) },
      facts: e.facts ?? null,
      endpoint: e.endpoint ?? null,
    };
  });
  return { provider: { id: provider, name: info.name, statusPageUrl: info.statusPageUrl }, evidence };
}

export function evidenceLabel(e: Evidence): string {
  switch (e.kind) {
    case 'call':
    case 'http':
      return `${e.detail} 호출`;
    case 'url':
      return `${e.detail} 주소`;
    case 'import':
      return `${e.detail} 사용`;
    case 'type':
      return `${e.detail} 주입`;
    case 'setting':
      return `${e.detail} 설정 사용`;
    case 'config':
      return e.detail;
    case 'manifest':
      return `${e.detail} 의존성`;
    case 'llm':
      return `AI 판단 · ${e.detail}`;
  }
}

function languageOf(path: string): string {
  const base = path.split('/').pop()!.toLowerCase();
  if (base.startsWith('.env')) return 'dotenv';
  if (base === 'pipfile') return 'toml';
  const ext = base.slice(base.lastIndexOf('.') + 1);
  return (
    { json: 'json', yml: 'yaml', yaml: 'yaml', xml: 'xml', csproj: 'xml', config: 'xml', properties: 'properties', toml: 'toml', gradle: 'groovy', kts: 'kotlin', txt: 'text' }[ext] ??
    'text'
  );
}
