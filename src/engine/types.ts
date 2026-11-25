import type { CodeFacts, EvidenceKind, ProviderId, SkipReason } from '../api/contract.js';

export type { CodeFacts, EvidenceKind, ProviderId, SkipReason };

export type Lang = 'typescript' | 'tsx' | 'javascript' | 'python' | 'java' | 'csharp';
export type Ecosystem = 'npm' | 'pypi' | 'maven' | 'nuget';

/** 저장소 루트 기준 상대 경로('/' 구분)와 내용 */
export interface RepoFile {
  path: string;
  content: string;
}

export interface Location {
  path: string;
  line: number;
}

export interface Evidence extends Location {
  provider: ProviderId;
  kind: EvidenceKind;
  /** 근거 문구 재료: 호출식, host, 모듈, 설정 키, 의존성 이름 */
  detail: string;
  role?: string;
  facts?: CodeFacts;
  ruleId?: string;
}

/** 규칙으로 판단하지 못해 LLM에 넘길 후보. occurrences는 서버에만 두고 LLM에는 보내지 않는다. */
export type AmbiguousItem =
  | { id: string; kind: 'http'; call: string; hint?: string; lang: Lang; occurrences: Location[] }
  | { id: string; kind: 'host'; host: string; occurrences: Location[] }
  | { id: string; kind: 'dependency'; ecosystem: Ecosystem; name: string; occurrences: Location[] };

export interface FileStatus {
  path: string;
  state: 'analyzed' | 'skipped' | 'other';
  reason?: SkipReason;
  lang?: Lang;
}

export interface EngineResult {
  evidence: Evidence[];
  files: FileStatus[];
  ambiguous: AmbiguousItem[];
  /** 스니펫을 만들 때 쓰는 원문 (분석한 파일만) */
  texts: Map<string, string>;
  stats: {
    files: number;
    analyzed: number;
    skipped: number;
    sourceChars: number;
    /** 사전 필터를 통과해 실제로 파싱한 파일 수 */
    parsedFiles: number;
    rulesetVersion: string;
  };
}
