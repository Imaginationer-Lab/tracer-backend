// 대체 서비스: 이 저장소가 그 서비스에서 실제로 쓰는 기능만 보고, 가장 적게 고쳐서 옮길 수 있는 서비스를 AI에게 묻는다.
// 판단 기준(기능 묶기·fit·순서)은 코드 규칙이 아니라 스킬 문서(skills/alternatives)에 있다. 서버는 분류에 맞는 참고 문서만 골라 넣는다.
// 답은 JSON 스키마로 받고(structured outputs), 남의 저장소 코드를 읽고 쓴 것이라 안전 검사만 한다:
//   id 형식, 분류, 기능·코드 번호가 입력에 있는지, in-repo 서비스가 실제로 저장소에 있는지, 문자열 길이. 순서는 AI 답 그대로.
// AI 입력에는 파일 경로를 넣지 않는다 (같은 코드를 쓰는 다른 저장소와 결과를 같이 쓰려고). 파일은 응답할 때 이 저장소 것으로 붙인다.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Alternative, AlternativeFit, EvidenceItem, ProviderCategory, UsedFeature } from '../../api/contract.js';
import { CATEGORIES, KNOWN_SERVICES, SERVICE_ID } from '../../engine/rules.js';

export const ALT_VERSION = 2;
export const MAX_ALTERNATIVES = 3;
const MAX_USES = 40;

export interface Skill {
  /** SKILL.md 본문 (머리말 제외) → system */
  instructions: string;
  /** 분류 → references/<분류>.md */
  references: Partial<Record<ProviderCategory, string>>;
  /** 스킬 문서가 바뀌면 저장된 결과를 다시 만든다 */
  version: string;
}

export const SKILL_DIR = join(process.cwd(), 'skills', 'alternatives');

export function loadSkill(dir = SKILL_DIR): Skill {
  const instructions = readFileSync(join(dir, 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim();
  const references: Skill['references'] = {};
  for (const c of CATEGORIES) {
    try {
      references[c] = readFileSync(join(dir, 'references', `${c}.md`), 'utf8').trim();
    } catch {
      // 없는 분류는 other를 쓴다
    }
  }
  const version = createHash('sha256').update(JSON.stringify([instructions, references])).digest('hex').slice(0, 12);
  return { instructions, references, version };
}

export function skillMessage(skill: Skill, input: AltInput): string {
  const ref = skill.references[input.service.category] ?? skill.references.other ?? '';
  return `${ref}

# 입력

${JSON.stringify(input)}`;
}

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
/** 답 모양. 길이·번호 범위는 스키마로 못 막아서 parseAltPlan에서 검사한다 */
export const ALT_SCHEMA = {
  type: 'object',
  properties: {
    features: {
      type: 'array',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, label: { type: 'string' }, uses: { type: 'array', items: { type: 'integer' } } },
        required: ['key', 'label', 'uses'],
        additionalProperties: false,
      },
    },
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES },
          fit: { type: 'string', enum: ['drop-in', 'in-repo', 'rewrite'] },
          summary: { type: 'string' },
          coverage: {
            type: 'array',
            items: {
              type: 'object',
              properties: { feature: { type: 'string' }, support: { type: 'string', enum: ['yes', 'partial', 'no'] }, note: nullableString },
              required: ['feature', 'support', 'note'],
              additionalProperties: false,
            },
          },
          settings: { type: 'array', items: { type: 'string' } },
          editUses: { type: 'array', items: { type: 'integer' } },
        },
        required: ['id', 'name', 'category', 'fit', 'summary', 'coverage', 'settings', 'editUses'],
        additionalProperties: false,
      },
    },
  },
  required: ['features', 'alternatives'],
  additionalProperties: false,
} as const;

/** 같은 호출(종류·문구·엔드포인트·코드)을 한 묶음으로. files는 이 저장소에서 그 호출이 있는 곳 */
export interface UseGroup {
  kind: string;
  label: string;
  endpoint: string | null;
  code: string[];
  files: { path: string; line: number }[];
}

export function useGroups(evidence: EvidenceItem[]): UseGroup[] {
  const groups = new Map<string, UseGroup>();
  for (const e of evidence) {
    const endpoint = e.endpoint ? `${e.endpoint.host}${e.endpoint.path ?? ''}` : null;
    const code = e.snippet.lines.map((l) => l.trim().slice(0, 200)).filter(Boolean);
    const key = JSON.stringify([e.reason.kind, e.reason.label, endpoint, code]);
    const g = groups.get(key) ?? { kind: e.reason.kind, label: e.reason.label, endpoint, code, files: [] };
    g.files.push({ path: e.path, line: e.line });
    groups.set(key, g);
  }
  return [...groups.values()].slice(0, MAX_USES);
}

export interface AltInput {
  service: { id: string; name: string; category: ProviderCategory; role: string };
  uses: { i: number; kind: string; label: string; endpoint: string | null; code: string[] }[];
  repoServices: { id: string; name: string; category: ProviderCategory }[];
}

export function buildAltInput(service: AltInput['service'], groups: UseGroup[], repoServices: AltInput['repoServices']): AltInput {
  return {
    service,
    uses: groups.map((g, i) => ({ i, kind: g.kind, label: g.label, endpoint: g.endpoint, code: g.code })),
    repoServices: [...repoServices].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** 저장 키: 판정 방식 + 입력 (파일 경로가 없어서 같은 코드면 저장소가 달라도 같다) */
export function altKey(input: AltInput, model: string, skillVersion: string): string {
  return `v${ALT_VERSION}|${model}|skill:${skillVersion}|${input.service.id}|${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

/** 저장하는 모양: 파일 대신 uses 번호 */
export interface AltPlan {
  features: { key: string; label: string; uses: number[] }[];
  alternatives: (Omit<Alternative, 'changes' | 'statusSupport' | 'fitLabel'> & { settings: string[]; editUses: number[] })[];
}

const FITS: AlternativeFit[] = ['drop-in', 'in-repo', 'rewrite'];
export const FIT_LABEL: Record<AlternativeFit, string> = { 'drop-in': '주소·키만 바꾸면 됨', 'in-repo': '저장소에 이미 있음', rewrite: '코드 수정 필요' };
const FEATURE_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SETTING = /^[A-Za-z0-9_.\- ]{1,64}$/;

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const indexes = (v: unknown, n: number): number[] => (Array.isArray(v) ? [...new Set(v.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < n))] : []);

/** 알려진 서비스 별칭은 그 id로 (s3 → aws-s3) */
function normalizeId(id: string): string {
  for (const k of Object.values(KNOWN_SERVICES)) if (k.aliases.includes(id)) return k.id;
  return id;
}

export function parseAltPlan(text: string, input: AltInput): AltPlan | null {
  let data: { features?: unknown; alternatives?: unknown };
  try {
    data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as typeof data;
  } catch {
    return null;
  }
  if (!Array.isArray(data.features) || !Array.isArray(data.alternatives)) return null;
  const n = input.uses.length;

  const features: AltPlan['features'] = [];
  for (const f of data.features as { key?: unknown; label?: unknown; uses?: unknown }[]) {
    const key = typeof f?.key === 'string' ? f.key : '';
    const label = str(f?.label, 40);
    const uses = indexes(f?.uses, n);
    if (!FEATURE_KEY.test(key) || !label || !uses.length || features.some((x) => x.key === key)) continue;
    features.push({ key, label, uses });
  }
  if (!features.length) return null;

  const repoIds = new Set(input.repoServices.map((s) => s.id));
  const seen = new Set<string>([input.service.id]);
  const alternatives: AltPlan['alternatives'] = [];
  for (const a of data.alternatives as Record<string, unknown>[]) {
    const id = typeof a?.id === 'string' ? normalizeId(a.id.toLowerCase()) : '';
    const name = str(a?.name, 60);
    const category = a?.category as ProviderCategory;
    if (!SERVICE_ID.test(id) || seen.has(id) || !name || !CATEGORIES.includes(category)) continue;
    let fit = FITS.includes(a?.fit as AlternativeFit) ? (a.fit as AlternativeFit) : 'rewrite';
    // 판정은 AI가 하되, "저장소에 이미 있음"은 사실이라 확인한다
    if (fit === 'in-repo' && !repoIds.has(id)) fit = 'rewrite';
    const given = new Map<string, { support: 'yes' | 'partial' | 'no'; note: string | null }>();
    if (Array.isArray(a.coverage)) {
      for (const c of a.coverage as { feature?: unknown; support?: unknown; note?: unknown }[]) {
        if (typeof c?.feature !== 'string' || !['yes', 'partial', 'no'].includes(c.support as string)) continue;
        given.set(c.feature, { support: c.support as 'yes' | 'partial' | 'no', note: str(c.note, 100) });
      }
    }
    // 답이 없는 기능은 안 되는 것으로 본다
    const coverage = features.map((f) => ({ feature: f.key, ...(given.get(f.key) ?? { support: 'no' as const, note: null }) }));
    const settings = Array.isArray(a.settings) ? [...new Set(a.settings.filter((s): s is string => typeof s === 'string' && SETTING.test(s.trim())).map((s) => s.trim()))].slice(0, 10) : [];
    seen.add(id);
    alternatives.push({ id, name, category, fit, summary: str(a.summary, 200) ?? '', coverage, settings, editUses: indexes(a.editUses, n) });
  }
  // 순서는 스킬 기준으로 AI가 정한 그대로
  return { features, alternatives: alternatives.slice(0, MAX_ALTERNATIVES) };
}

const filesOf = (groups: UseGroup[], uses: number[]) => {
  const out = new Map<string, { path: string; line: number }>();
  for (const i of uses) for (const f of groups[i]?.files ?? []) if (!out.has(`${f.path}:${f.line}`)) out.set(`${f.path}:${f.line}`, f);
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
};

/** 저장한 계획 + 이 저장소의 파일 → 응답 */
export function presentAlternatives(plan: AltPlan, groups: UseGroup[], support: (id: string) => 'live' | 'none'): { features: UsedFeature[]; alternatives: Alternative[] } {
  return {
    features: plan.features.map((f) => ({ key: f.key, label: f.label, files: filesOf(groups, f.uses) })),
    alternatives: plan.alternatives.map(({ settings, editUses, ...a }) => ({
      ...a,
      fitLabel: FIT_LABEL[a.fit],
      changes: { settings, files: filesOf(groups, editUses) },
      statusSupport: support(a.id),
    })),
  };
}
