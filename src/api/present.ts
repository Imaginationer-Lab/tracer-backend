// 엔진 결과 → HTTP 응답 모양 (docs/api.md)

import { categoryOf, FEATURED_ORDER, KNOWN_SERVICES, type ServiceInfo } from '../engine/rules.js';
import type { EngineResult, Evidence } from '../engine/types.js';
import type { AnalysisResult, EvidenceItem, FileEntry, ProviderDetail, ProviderId, ProviderSummary } from './contract.js';

/** 응답 확인할 호스트 (probe 결과는 조회할 때 붙인다) */
export interface HostTarget {
  name: string;
  host: string;
  files: { path: string; line: number }[];
}

/** 저장하는 세부정보: hosts 대신 확인할 호스트 목록. 예전 결과에는 targets가 없다 */
export type StoredDetail = Omit<ProviderDetail, 'hosts'> & { targets?: HostTarget[] };

export const MAX_HOSTS = 3;
const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** 근거의 endpoint.host → 서비스당 최대 3개 (부르는 파일이 많은 순). '*'가 들어간 동적 호스트는 뺀다. 없으면 대표 호스트 */
export function hostTargets(uses: { host: string; path: string; line: number }[], info: ServiceInfo): HostTarget[] {
  const byHost = new Map<string, Map<string, number>>();
  for (const u of uses) {
    const host = u.host.toLowerCase().replace(/\.$/, '');
    if (!HOSTNAME.test(host)) continue;
    const files = byHost.get(host) ?? new Map<string, number>();
    files.set(u.path, Math.min(files.get(u.path) ?? Infinity, u.line));
    byHost.set(host, files);
  }
  const out = [...byHost]
    .map(([host, files]) => ({ name: host.split('.')[0]!, host, files: [...files].map(([path, line]) => ({ path, line })).sort((a, b) => a.path.localeCompare(b.path)) }))
    .sort((a, b) => b.files.length - a.files.length || a.host.localeCompare(b.host))
    .slice(0, MAX_HOSTS);
  if (!out.length && info.probeHost) out.push({ name: info.probeHost.split('.')[0]!, host: info.probeHost, files: [] });
  return out;
}

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

export type ServiceDirectory = Map<ProviderId, ServiceInfo>;

/** 판정에 없는 id면 (예전 결과 등) 알려진 서비스, 그것도 아니면 id 그대로 */
export function serviceInfo(id: ProviderId, directory: ServiceDirectory): ServiceInfo {
  const known = KNOWN_SERVICES[id];
  return directory.get(id) ?? (known ? { ...known } : { id, name: id, category: 'other', role: '외부 서비스', statusPageUrl: null });
}

const featured = (id: string) => {
  const i = FEATURED_ORDER.indexOf(id);
  return i < 0 ? FEATURED_ORDER.length : i;
};

export function toAnalysisResult(r: EngineResult, directory: ServiceDirectory = new Map()): AnalysisResult {
  const ids = [...new Set(r.evidence.map((e) => e.provider))];
  const providers: ProviderSummary[] = [];
  for (const id of ids) {
    const { used, list } = evidenceFor(r, id);
    if (!list.length) continue;
    const info = serviceInfo(id, directory);
    const roles = new Map<string, number>();
    for (const e of list) if (e.role) roles.set(e.role, (roles.get(e.role) ?? 0) + 1);
    const role = [...roles].sort((a, b) => b[1] - a[1])[0]?.[0] ?? info.role;
    const files = [...bestByFile(list).values()]
      .sort((a, b) => PRIORITY[b.kind] - PRIORITY[a.kind] || a.path.localeCompare(b.path))
      .map((e) => ({ path: e.path, line: e.line }));
    providers.push({
      id,
      name: info.name,
      role,
      category: categoryOf(info, role),
      fileCount: files.length,
      files,
      usage: used ? 'used' : 'declared-only',
      statusSupport: info.statusApi ? 'live' : 'none',
    });
  }
  // 디자인의 세 서비스 → 근거 파일이 많은 순 → 이름순
  providers.sort((a, b) => featured(a.id) - featured(b.id) || b.fileCount - a.fileCount || a.name.localeCompare(b.name));
  const order = new Map(providers.map((p, i) => [p.id, i]));

  const matches = new Map<string, { provider: ProviderId; line: number }[]>();
  for (const p of providers) {
    for (const [path, e] of bestByFile(evidenceFor(r, p.id).list)) {
      matches.set(path, [...(matches.get(path) ?? []), { provider: p.id, line: e.line }]);
    }
  }
  for (const list of matches.values()) list.sort((a, b) => order.get(a.provider)! - order.get(b.provider)!);

  let statuses = r.files;
  if (statuses.length > MAX_PATHS) statuses = statuses.filter((f) => f.state !== 'other');
  const files: FileEntry[] = statuses.map((f) =>
    f.state === 'analyzed'
      ? { path: f.path, state: 'analyzed', matches: matches.get(f.path) ?? [] }
      : f.state === 'skipped'
        ? { path: f.path, state: 'skipped', reason: f.reason ?? 'parse-error' }
        : { path: f.path, state: 'other' },
  );

  return { providers, otherServices: [], files, summary: { analyzed: r.stats.analyzed, skipped: r.stats.skipped } };
}

export function toProviderDetail(r: EngineResult, provider: ProviderId, directory: ServiceDirectory = new Map()): StoredDetail {
  const info = serviceInfo(provider, directory);
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
  const uses = r.evidence.flatMap((e) => (e.provider === provider && e.endpoint ? [{ host: e.endpoint.host, path: e.path, line: e.line }] : []));
  return { provider: { id: provider, name: info.name, statusPageUrl: info.statusPageUrl }, evidence, targets: hostTargets(uses, info) };
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
