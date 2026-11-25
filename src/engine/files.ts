import type { Ecosystem, Lang, SkipReason } from './types.js';

export const MAX_SOURCE_BYTES = 512 * 1024;

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.output', '.svelte-kit', '.vercel', '.turbo', '.cache',
  'coverage', 'vendor', 'storybook-static', '__pycache__', '.venv', 'venv', 'site-packages', '.mypy_cache', '.pytest_cache',
  'target', '.gradle', '.idea', 'bin', 'obj', '.vs', 'test', 'tests', '__tests__', '__mocks__', 'e2e', 'cypress', 'testdata',
]);

const TEST_FILE = /(\.d\.ts|\.(test|spec|stories|e2e)\.[cm]?[jt]sx?|_test\.py|(^|\/)test_[^/]+\.py|Tests?\.(java|cs))$/;

export type PathRole =
  | { kind: 'source'; lang: Lang; embedded?: 'svelte' | 'vue' }
  | { kind: 'manifest'; ecosystem: Ecosystem; format: 'package.json' | 'requirements' | 'pyproject' | 'pipfile' | 'pom' | 'gradle' | 'csproj' | 'packages.config' }
  | { kind: 'config'; format: 'env' | 'properties' | 'yaml' | 'json' }
  | { kind: 'other' }
  | { kind: 'ignored' };

export function classifyPath(path: string): PathRole {
  const segments = path.split('/');
  if (segments.slice(0, -1).some((s) => IGNORED_DIRS.has(s))) return { kind: 'ignored' };
  const base = segments[segments.length - 1]!;
  const lower = base.toLowerCase();

  if (base === 'package.json') return { kind: 'manifest', ecosystem: 'npm', format: 'package.json' };
  if (/^requirements.*\.txt$/.test(lower)) return { kind: 'manifest', ecosystem: 'pypi', format: 'requirements' };
  if (lower === 'pyproject.toml') return { kind: 'manifest', ecosystem: 'pypi', format: 'pyproject' };
  if (lower === 'pipfile') return { kind: 'manifest', ecosystem: 'pypi', format: 'pipfile' };
  if (lower === 'pom.xml') return { kind: 'manifest', ecosystem: 'maven', format: 'pom' };
  if (lower === 'build.gradle' || lower === 'build.gradle.kts') return { kind: 'manifest', ecosystem: 'maven', format: 'gradle' };
  if (lower.endsWith('.csproj')) return { kind: 'manifest', ecosystem: 'nuget', format: 'csproj' };
  if (lower === 'packages.config') return { kind: 'manifest', ecosystem: 'nuget', format: 'packages.config' };

  if (/^\.env(\..+)?$/.test(lower)) return { kind: 'config', format: 'env' };
  if (/^application(-[\w-]+)?\.properties$/.test(lower)) return { kind: 'config', format: 'properties' };
  if (/^application(-[\w-]+)?\.ya?ml$/.test(lower) || /^bootstrap\.ya?ml$/.test(lower)) return { kind: 'config', format: 'yaml' };
  if (/^appsettings(\.[\w-]+)?\.json$/.test(lower)) return { kind: 'config', format: 'json' };

  if (TEST_FILE.test(path)) return { kind: 'other' };
  const ext = lower.slice(lower.lastIndexOf('.'));
  const lang = EXT_LANG[ext];
  if (lang) return { kind: 'source', lang };
  if (ext === '.svelte') return { kind: 'source', lang: 'typescript', embedded: 'svelte' };
  if (ext === '.vue') return { kind: 'source', lang: 'typescript', embedded: 'vue' };
  return { kind: 'other' };
}

const EXT_LANG: Record<string, Lang> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.java': 'java', '.cs': 'csharp',
};

/** 분석 대상 소스인데 읽지 않고 건너뛸 이유가 있는지 */
export function skipReason(path: string, content: string): SkipReason | null {
  if (content.length > MAX_SOURCE_BYTES) return 'too-large';
  if (/\.min\.[cm]?js$/.test(path)) return 'minified';
  const lines = content.split('\n');
  if (content.length > 5000 && content.length / lines.length > 400) return 'minified';
  return null;
}

/**
 * Svelte·Vue 파일에서 <script> 블록만 남긴다. 나머지는 줄바꿈만 남기고 지워서 줄 번호가 원본과 같다.
 * TS 문법으로 파싱하면 JS도 그대로 읽힌다.
 */
export function extractScriptBlocks(content: string): string {
  const out = content.replace(/[^\n]/g, ' ').split('');
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    const start = m.index + m[0].indexOf('>') + 1;
    for (let i = 0; i < m[1]!.length; i++) out[start + i] = content[start + i]!;
  }
  return out.join('');
}
