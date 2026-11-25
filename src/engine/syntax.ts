// tree-sitter로 소스 한 파일을 읽어 언어와 무관한 "사실(FileFacts)"로 바꾼다.
// 언어별 차이는 lang/*.ts의 Hooks에만 있고, 해석(resolve.ts)은 FileFacts만 본다.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Language as TSLanguage, Node, Parser as TSParser } from '@vscode/tree-sitter-wasm';
import type { Lang } from './types.js';

export type { Node };

// ─── 파일 사실 ──────────────────────────────────────────────────────────────

/** 리터럴 패턴 안에서 동적인 부분을 나타내는 표시 */
export const DYN = '\u0001';

/** URL·설정값이 될 수 있는 식을 정적으로 본 모습 */
export interface ValueFact {
  text: string;
  /** 리터럴만 남긴 문자열. 동적인 부분은 DYN. `https://${ref}.supabase.co` → 'https://\u0001.supabase.co' */
  pattern?: string;
  /** 패턴이 동적인 부분으로 시작할 때 그 부분. `${BASE}/v1` → BASE */
  head?: ValueFact;
  /** 환경변수·설정 키 읽기 */
  setting?: string;
  /** 변수·필드 이름 (this.x, self.x 포함) */
  ident?: string;
  /** a ?? b, a || b, cond ? a : b */
  alts?: ValueFact[];
}

export interface ImportFact {
  module: string;
  line: number;
  /** imported: 'default' · '*' · 이름 */
  bindings: { local: string; imported: string }[];
  /** C# using, Java .*, Python from x import * : 어떤 이름이 들어오는지 모름 */
  wildcard: boolean;
  typeOnly: boolean;
}

export interface CallFact {
  line: number;
  /** 원래 호출식 이름: 'stripe.paymentIntents.create' · 'this.c.send' · 'supabase.from().select' */
  callee: string;
  isNew: boolean;
  args: ValueFact[];
  /** 키워드 인자, 첫 객체 인자의 속성, 객체 초기화자 */
  options: Record<string, ValueFact>;
  /** LLM에 보낼 짧은 형태: callee(arg0, …) */
  text: string;
  assignedTo?: string;
  scope: number;
  inTry: boolean;
}

export interface DeclFact {
  name: string;
  line: number;
  kind: 'var' | 'field' | 'param' | 'function';
  type?: string;
  value?: ValueFact;
  /** 초기값이 호출이면 그 CallFact 인덱스 */
  initCall?: number;
  /** 초기값·함수 본문에서 참조한 이름 */
  refs: string[];
  exported: boolean;
}

export interface FileFacts {
  lang: Lang;
  imports: ImportFact[];
  calls: CallFact[];
  decls: DeclFact[];
  settings: { key: string; line: number }[];
  strings: { value: string; line: number }[];
  /** 0번은 파일 전체. 함수 단위 줄 범위 */
  scopes: { start: number; end: number }[];
  exportAliases: { local: string; exported: string }[];
  classes: string[];
  /** 주석을 공백으로 지운 원문 (줄 번호 유지). 코드 사실 판단에 쓴다 */
  code: string;
}

// ─── 언어별 훅 ──────────────────────────────────────────────────────────────

export interface CallShape {
  calleeNode: Node | null;
  /** calleeNode가 없을 때 쓰는 이름 (Java 메서드 호출, 어노테이션) */
  calleeText?: string;
  isNew: boolean;
  args: Node[];
  options: [string, Node][];
}

export interface DeclShape {
  name: string;
  kind: DeclFact['kind'];
  type?: string;
  value?: Node | null;
  /** 함수 본문 등 참조 이름을 모을 노드 */
  body?: Node | null;
  /** 값 대신 쓸 설정 읽기 (Java @Value) */
  setting?: string;
}

export interface Hooks {
  lang: Lang;
  imports(n: Node): Omit<ImportFact, 'line'>[] | null;
  call(n: Node): CallShape | null;
  decls(n: Node): DeclShape[] | null;
  /** 이 노드가 환경변수·설정 읽기면 키 */
  setting(n: Node): string | null;
  /** 문자열 리터럴(보간 없음)이면 값 */
  literal(n: Node): string | null;
  /** 보간 문자열·문자열 더하기면 조각들 */
  parts(n: Node): (string | Node)[] | null;
  alts(n: Node): Node[] | null;
  /** 이름이면 그 이름 (this.x, self.x → x) */
  ident(n: Node): string | null;
  calleeText(n: Node): string;
  /** 괄호, await, non-null 단언, 타입 단언 등을 벗긴다 */
  unwrap(n: Node): Node;
  isScope(n: Node): Node | null;
  tryBody(n: Node): Node | null;
  /** 참조 이름 수집에서 이름으로 셀 노드인지 */
  isRef(n: Node): string | null;
  className(n: Node): string | null;
  exportAliases?(n: Node): { local: string; exported: string }[] | null;
  isExported?(n: Node): boolean;
}

// ─── 공통 도우미 ────────────────────────────────────────────────────────────

export const lineOf = (n: Node) => n.startPosition.row + 1;
export const named = (n: Node | null | undefined): Node[] => (n ? (n.namedChildren.filter(Boolean) as Node[]) : []);
export const field = (n: Node, name: string) => n.childForFieldName(name);
export const collapse = (s: string, max = 120) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
export const stripGenerics = (t: string) => t.replace(/<.*>/s, '').replace(/[?\[\]\s]/g, '');

// ─── 추출 ──────────────────────────────────────────────────────────────────

export function extractFacts(root: Node, hooks: Hooks, content: string): FileFacts {
  const facts: FileFacts = {
    lang: hooks.lang,
    imports: [],
    calls: [],
    decls: [],
    settings: [],
    strings: [],
    scopes: [{ start: 1, end: content.split('\n').length }],
    exportAliases: [],
    classes: [],
    code: content,
  };
  const comments: [number, number][] = [];

  const valueOf = (input: Node, depth = 0): ValueFact => {
    const n = hooks.unwrap(input);
    const text = collapse(n.text);
    if (depth > 6) return { text };
    const setting = hooks.setting(n);
    if (setting) return { text, setting };
    const lit = hooks.literal(n);
    if (lit !== null) return { text, pattern: lit };
    const parts = hooks.parts(n);
    if (parts) {
      let pattern = '';
      let head: ValueFact | undefined;
      for (const p of parts) {
        if (typeof p === 'string') {
          pattern += p;
          continue;
        }
        const v = valueOf(p, depth + 1);
        if (v.pattern !== undefined && !v.pattern.includes(DYN) && !v.alts) pattern += v.pattern;
        else {
          if (pattern === '' && !head) head = v;
          pattern += DYN;
        }
      }
      return { text, pattern, ...(head ? { head } : {}) };
    }
    const alts = hooks.alts(n);
    if (alts) return { text, alts: alts.map((a) => valueOf(a, depth + 1)) };
    const ident = hooks.ident(n);
    if (ident) return { text, ident };
    // new URL(path, base) · URI.create(x) · new Uri(x): 주소는 마지막 인자(기준 주소)에 있다
    const call = hooks.call(n);
    if (call) {
      const name = call.calleeNode ? hooks.calleeText(call.calleeNode) : (call.calleeText ?? '');
      if (/^(URL|URI|Uri|URI\.create|urljoin|urllib\.parse\.urljoin)$/.test(name) && call.args.length) {
        return { ...valueOf(call.args[call.args.length - 1]!, depth + 1), text };
      }
    }
    return { text };
  };

  const refsOf = (n: Node | null | undefined): string[] => {
    const out = new Set<string>();
    const walk = (x: Node) => {
      const r = hooks.isRef(x);
      if (r) out.add(r);
      for (const c of named(x)) walk(c);
    };
    if (n) walk(n);
    return [...out];
  };

  const visit = (n: Node, scope: number, inTry: boolean, exported: boolean) => {
    if (n.type.includes('comment')) {
      comments.push([n.startIndex, n.endIndex]);
      return;
    }
    const line = lineOf(n);

    const scopeNode = hooks.isScope(n);
    if (scopeNode) {
      facts.scopes.push({ start: lineOf(scopeNode), end: scopeNode.endPosition.row + 1 });
      scope = facts.scopes.length - 1;
    }
    exported ||= hooks.isExported?.(n) ?? false;

    const imports = hooks.imports(n);
    if (imports) for (const imp of imports) facts.imports.push({ ...imp, line });

    const cls = hooks.className(n);
    if (cls) facts.classes.push(cls);

    const aliases = hooks.exportAliases?.(n);
    if (aliases) facts.exportAliases.push(...aliases);

    const setting = hooks.setting(n);
    if (setting) facts.settings.push({ key: setting, line });

    const lit = hooks.literal(n);
    if (lit !== null && lit.length > 3) facts.strings.push({ value: lit, line });
    else if (hooks.parts(n)) {
      const v = valueOf(n);
      if (v.pattern && v.pattern.length > 3) facts.strings.push({ value: v.pattern, line });
    }

    const call = hooks.call(n);
    if (call) {
      const callee = call.calleeNode ? hooks.calleeText(call.calleeNode) : (call.calleeText ?? '?');
      const args = call.args.slice(0, 2).map((a) => valueOf(a));
      const options: Record<string, ValueFact> = {};
      for (const [k, v] of call.options) options[k] = valueOf(v);
      const argText = args[0] ? `${args[0].text}${call.args.length > 1 ? ', …' : ''}` : '';
      facts.calls.push({
        line,
        callee,
        isNew: call.isNew,
        args,
        options,
        text: collapse(`${call.isNew ? 'new ' : ''}${callee}(${argText})`, 160),
        scope,
        inTry,
      });
      callIndexByNode.set(n.id, facts.calls.length - 1);
    }

    const decls = hooks.decls(n);
    if (decls) {
      for (const d of decls) {
        const value = d.setting ? { text: d.setting, setting: d.setting } : d.value ? valueOf(d.value) : undefined;
        const fact: DeclFact = {
          name: d.name,
          line,
          kind: d.kind,
          ...(d.type ? { type: stripGenerics(d.type) } : {}),
          ...(value ? { value } : {}),
          refs: refsOf(d.body ?? d.value),
          exported,
        };
        facts.decls.push(fact);
        // 초기값 호출은 자식을 방문할 때 등록되므로 방문이 끝난 뒤 연결한다
        if (d.value) pendingInit.push({ decl: fact, nodeId: hooks.unwrap(d.value).id });
      }
    }

    const body = hooks.tryBody(n);
    for (const child of named(n)) {
      const childInTry = inTry || (body !== null && child.id === body.id);
      visit(child, scope, childInTry, exported);
    }
  };

  const pendingInit: { decl: DeclFact; nodeId: number }[] = [];
  const callIndexByNode = new Map<number, number>();
  visit(root, 0, false, false);

  // 선언의 초기값이 호출이면 그 호출을 연결한다 (const s3 = new S3Client() → s3)
  for (const { decl, nodeId } of pendingInit) {
    const idx = callIndexByNode.get(nodeId);
    if (idx !== undefined) {
      decl.initCall = idx;
      facts.calls[idx]!.assignedTo ??= decl.name;
    }
  }

  if (comments.length) {
    const chars = content.split('');
    for (const [s, e] of comments) for (let i = s; i < e; i++) if (chars[i] !== '\n') chars[i] = ' ';
    facts.code = chars.join('');
  }
  return facts;
}

// ─── tree-sitter 로딩 ──────────────────────────────────────────────────────

const require = createRequire(import.meta.url);
const runtime = require('@vscode/tree-sitter-wasm') as { Parser: typeof TSParser; Language: typeof TSLanguage };
const wasmDir = dirname(require.resolve('@vscode/tree-sitter-wasm'));

const GRAMMAR: Record<Lang, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  java: 'tree-sitter-java.wasm',
  csharp: 'tree-sitter-c-sharp.wasm',
};

let ready: Promise<void> | null = null;
const parsers = new Map<Lang, Promise<TSParser>>();

export function getParser(lang: Lang): Promise<TSParser> {
  ready ??= runtime.Parser.init({ locateFile: (file: string) => join(wasmDir, file) });
  let p = parsers.get(lang);
  if (!p) {
    p = ready.then(async () => {
      const language = await runtime.Language.load(join(wasmDir, GRAMMAR[lang]));
      const parser = new runtime.Parser();
      parser.setLanguage(language);
      return parser;
    });
    parsers.set(lang, p);
  }
  return p;
}
