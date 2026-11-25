// 파싱 전에 "관련 코드가 있을 만한 파일"을 고르는 단계.
//   ② 텍스트 단서: 네트워크 호출·설정 읽기가 보이는 파일, 그리고 AI가 서비스로 판정한 모듈·호스트 이름이 보이는 파일
//   ③ 1-hop 보강: ②에서 공급자 흔적이 확인된 파일을 import 경로나 클래스 이름으로 참조하는 파일
// 로컬 저장소 측정에서 ②만으로 파싱할 파일이 1.4~21.5%로 줄었다 (scripts/bench-parse.mjs).

import { posix } from 'node:path';
import type { Rule } from './rules.js';
import type { Lang } from './types.js';

export const TEXT_SIGNAL = new RegExp(
  [
    String.raw`https?://`,
    String.raw`\bfetch\s*\(`, String.raw`\baxios\b`, String.raw`\bky\b`, String.raw`\bgot\s*\(`, String.raw`\$fetch`, String.raw`\bofetch\b`,
    String.raw`\brequests\.`, String.raw`\bhttpx\b`, String.raw`\baiohttp\b`, String.raw`\burllib\b`, String.raw`\bboto3\b`,
    String.raw`RestTemplate`, String.raw`WebClient`, String.raw`HttpClient`, String.raw`FeignClient`, String.raw`OkHttp`, String.raw`RestClient`, String.raw`HttpRequest`,
    String.raw`process\.env`, String.raw`import\.meta\.env`, String.raw`\$env/`, String.raw`os\.getenv`, String.raw`os\.environ`, String.raw`\bsettings\.`,
    String.raw`System\.getenv`, String.raw`@Value\s*\(`, String.raw`@ConfigurationProperties`, String.raw`getProperty\s*\(`,
    String.raw`GetEnvironmentVariable`, String.raw`[Cc]onfiguration\s*\[`, String.raw`_config\s*\[`, String.raw`GetValue<`, String.raw`GetSection\s*\(`,
  ].join('|'),
);

/**
 * 파싱할 파일을 고르는 텍스트 거름망. 공통 신호(HTTP 호출·URL·설정 읽기)에 더해,
 * 이번 분석의 규칙(AI 판정에서 만든 import 모듈·호스트)에 나온 글자를 찾는다.
 */
export function textSignal(rules: Rule[]): RegExp {
  const words = new Set<string>();
  for (const r of rules) {
    const m = r.match;
    const pats = m.type === 'import' ? m.module : m.type === 'host' ? m.host : m.type === 'type' ? m.name : m.type === 'call' ? m.callee : [];
    for (const p of Array.isArray(pats) ? pats : [pats]) {
      // 글롭에서 가장 긴 고정 조각만 쓴다 ('@aws-sdk/client-s3' → 그대로, '*.supabase.co' → '.supabase.co')
      const longest = p.split('*').sort((a, b) => b.length - a.length)[0]!;
      if (longest.replace(/[^\w]/g, '').length >= 3) words.add(longest);
    }
  }
  if (!words.size) return TEXT_SIGNAL;
  const escaped = [...words].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`${TEXT_SIGNAL.source}|${escaped.join('|')}`);
}

const JS_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs', '.svelte', '.vue', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];
const isJs = (lang: Lang) => lang === 'typescript' || lang === 'tsx' || lang === 'javascript';

/** import 문자열이 저장소 안의 어떤 파일을 가리키는지 (JS/TS·Python만. Java·C#은 클래스 이름으로 잇는다) */
export function resolveModulePath(from: string, module: string, lang: Lang, files: Set<string>): string | null {
  if (isJs(lang)) {
    let bases: string[];
    if (module.startsWith('.')) bases = [posix.join(posix.dirname(from), module)];
    else if (/^[@~]\//.test(module)) bases = [`src/${module.slice(2)}`, module.slice(2)];
    else if (module.startsWith('$lib/')) bases = [`src/lib/${module.slice(5)}`];
    else return null;
    for (const raw of bases) {
      const base = posix.normalize(raw);
      for (const s of JS_SUFFIXES) if (files.has(base + s)) return base + s;
      // ESM TS는 './a.js'로 쓰고 실제 파일은 a.ts
      const swapped = base.replace(/\.(m?)js$/, '.$1ts');
      if (swapped !== base && files.has(swapped)) return swapped;
    }
    return null;
  }
  if (lang === 'python') {
    let bases: string[];
    if (module.startsWith('.')) {
      const dots = /^\.+/.exec(module)![0].length;
      let dir = posix.dirname(from);
      for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
      const rest = module.slice(dots).replace(/\./g, '/');
      bases = [rest ? posix.join(dir, rest) : dir];
    } else {
      const rel = module.replace(/\./g, '/');
      bases = [rel, `src/${rel}`];
    }
    for (const raw of bases) {
      const base = posix.normalize(raw).replace(/^\.\//, '');
      for (const c of [`${base}.py`, `${base}/__init__.py`]) if (files.has(c)) return c;
    }
  }
  return null;
}

/** 파싱하지 않고 텍스트로 import 대상 모듈 문자열을 뽑는다 (1-hop 보강용) */
export function scanImportSpecifiers(source: string, lang: Lang): string[] {
  const out: string[] = [];
  if (isJs(lang)) {
    const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
    for (let m = re.exec(source); m; m = re.exec(source)) out.push(m[1]!);
  } else if (lang === 'python') {
    const from = /^\s*from\s+([.\w]+)\s+import\s+\(?([^\n#)]+)/gm;
    for (let m = from.exec(source); m; m = from.exec(source)) {
      const mod = m[1]!;
      out.push(mod);
      // from app.lib import stripe_client 처럼 이름이 하위 모듈일 수 있다
      for (const name of m[2]!.split(',').map((s) => s.trim().split(/\s+as\s+/)[0]!).filter(Boolean)) {
        out.push(mod.endsWith('.') ? mod + name : `${mod}.${name}`);
      }
    }
    const imp = /^\s*import\s+([\w.]+)/gm;
    for (let m = imp.exec(source); m; m = imp.exec(source)) out.push(m[1]!);
  }
  return out;
}

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
  'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

/**
 * JS·TS에서 import하는 외부 패키지 이름과 줄 (파싱 없이 정규식으로, 모든 파일에서).
 * package.json에 선언하지 않고 쓰는 패키지(모노레포, 프레임워크 템플릿)도 후보로 만들기 위해 쓴다.
 */
export function scanPackageImports(source: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const spec = m[1]!;
    // 상대 경로, 별칭(@/ ~/ #), SvelteKit·Vite 가상 모듈($app, virtual:), node: 내장
    if (/^(?:\.|\/|[@~#]\/|\$|#|virtual:|node:|bun:|https?:)/.test(spec)) continue;
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
    if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name) || NODE_BUILTINS.has(name)) continue;
    out.push({ name, line: source.slice(0, m.index + m[0].length).split('\n').length });
  }
  return out;
}

/** Java·C#·TS 클래스 이름 참조 (주입된 PaymentService 같은 1-hop) */
export function mentionsAny(source: string, names: Set<string>): boolean {
  if (!names.size) return false;
  const re = new RegExp(`\\b(?:${[...names].map((n) => n.replace(/[^\w]/g, '')).filter(Boolean).join('|')})\\b`);
  return re.test(source);
}
