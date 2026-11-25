// 언어와 무관한 공통층: 매니페스트(의존성)와 설정 파일(키 → 값).
// Java·.NET은 외부 주소가 코드가 아니라 application.yml·appsettings.json에 있는 경우가 대부분이라
// 여기서 만든 설정 표로 코드의 설정 참조(@Value, config["A:B"], os.getenv)를 이어준다.

import { normalizeKey } from './glob.js';
import type { PathRole } from './files.js';
import type { Ecosystem } from './types.js';

export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  path: string;
  line: number;
}

export interface SettingEntry {
  key: string;
  normalized: string;
  value: string;
  path: string;
  line: number;
}

type ManifestRole = Extract<PathRole, { kind: 'manifest' }>;
type ConfigRole = Extract<PathRole, { kind: 'config' }>;

const lineAt = (content: string, index: number) => content.slice(0, index).split('\n').length;

export function parseManifest(role: ManifestRole, path: string, content: string): Dependency[] {
  const deps: Dependency[] = [];
  const add = (name: string, line: number) => deps.push({ ecosystem: role.ecosystem, name, path, line });
  const lines = content.split('\n');

  switch (role.format) {
    case 'package.json': {
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(content);
      } catch {
        return deps;
      }
      // devDependencies는 운영 코드가 부르는 서비스가 아니라서 뺀다
      for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        const names = Object.keys((json[section] as Record<string, string>) ?? {});
        const sectionLine = lines.findIndex((l) => l.includes(`"${section}"`));
        for (const name of names) {
          const idx = lines.findIndex((l, i) => i > sectionLine && l.includes(`"${name}"`));
          add(name, idx >= 0 ? idx + 1 : 1);
        }
      }
      break;
    }
    case 'requirements':
      lines.forEach((raw, i) => {
        const l = raw.replace(/#.*/, '').trim();
        const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(l);
        if (m && !l.startsWith('-')) add(m[1]!.toLowerCase(), i + 1);
      });
      break;
    case 'pyproject': {
      // [project] dependencies = ["stripe>=7", ...]
      const block = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(content);
      if (block) {
        const re = /["']([A-Za-z0-9][A-Za-z0-9._-]*)/g;
        for (let m = re.exec(block[1]!); m; m = re.exec(block[1]!)) add(m[1]!.toLowerCase(), lineAt(content, block.index + m.index));
      }
      // [tool.poetry.dependencies]
      collectTomlSectionKeys(lines, /^\[tool\.poetry\.dependencies\]/, (name, line) => name !== 'python' && add(name.toLowerCase(), line));
      break;
    }
    case 'pipfile':
      collectTomlSectionKeys(lines, /^\[packages\]/, (name, line) => add(name.toLowerCase(), line));
      break;
    case 'pom': {
      const re = /<dependency>([\s\S]*?)<\/dependency>/g;
      for (let m = re.exec(content); m; m = re.exec(content)) {
        const g = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(m[1]!)?.[1];
        const a = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(m[1]!)?.[1];
        if (g && a) add(`${g}:${a}`, lineAt(content, m.index));
      }
      break;
    }
    case 'gradle':
      lines.forEach((l, i) => {
        const m = /\b(?:implementation|api|compile|compileOnly|runtimeOnly)\b\s*\(?\s*["']([^"':\s]+):([^"':\s]+)/.exec(l);
        if (m) add(`${m[1]}:${m[2]}`, i + 1);
      });
      break;
    case 'csproj':
    case 'packages.config': {
      const re = role.format === 'csproj' ? /<PackageReference\s+[^>]*Include="([^"]+)"/g : /<package\s+[^>]*id="([^"]+)"/g;
      for (let m = re.exec(content); m; m = re.exec(content)) add(m[1]!, lineAt(content, m.index));
      break;
    }
  }
  return deps;
}

function collectTomlSectionKeys(lines: string[], header: RegExp, onKey: (name: string, line: number) => void) {
  const start = lines.findIndex((l) => header.test(l.trim()));
  if (start < 0) return;
  for (let i = start + 1; i < lines.length && !lines[i]!.trim().startsWith('['); i++) {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(lines[i]!);
    if (m) onKey(m[1]!, i + 1);
  }
}

export function parseConfig(role: ConfigRole, path: string, content: string): SettingEntry[] {
  const entries: SettingEntry[] = [];
  const add = (key: string, rawValue: string, line: number) => {
    const value = springDefault(unquote(rawValue.trim()));
    entries.push({ key, normalized: normalizeKey(key), value, path, line });
  };
  const lines = content.split('\n');

  switch (role.format) {
    case 'env':
      lines.forEach((l, i) => {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(l);
        if (m) add(m[1]!, stripInlineComment(m[2]!), i + 1);
      });
      break;
    case 'properties':
      lines.forEach((l, i) => {
        if (/^\s*[#!]/.test(l)) return;
        const m = /^\s*([^=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(l);
        if (m) add(m[1]!, m[2]!, i + 1);
      });
      break;
    case 'yaml': {
      // Spring 설정 정도만 읽는 최소 YAML: 중첩 맵과 스칼라 값. 목록은 건너뛴다.
      const stack: { indent: number; key: string }[] = [];
      lines.forEach((l, i) => {
        if (/^\s*(#|-|$)/.test(l)) return;
        const m = /^(\s*)([^:#]+?)\s*:(?:\s+(.*))?$/.exec(l);
        if (!m) return;
        const indent = m[1]!.length;
        while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
        const key = unquote(m[2]!.trim());
        const value = stripInlineComment(m[3] ?? '');
        if (value === '' || value === '|' || value === '>') stack.push({ indent, key });
        else add([...stack.map((s) => s.key), key].join('.'), value, i + 1);
      });
      break;
    }
    case 'json': {
      let json: unknown;
      try {
        json = JSON.parse(stripJsonComments(content));
      } catch {
        return entries;
      }
      const walk = (node: unknown, prefix: string[]) => {
        if (node && typeof node === 'object' && !Array.isArray(node)) {
          for (const [k, v] of Object.entries(node)) walk(v, [...prefix, k]);
        } else if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
          const leaf = prefix[prefix.length - 1]!;
          const idx = lines.findIndex((l) => l.includes(`"${leaf}"`) && l.includes(String(node)));
          add(prefix.join(':'), String(node), (idx >= 0 ? idx : lines.findIndex((l) => l.includes(`"${leaf}"`))) + 1);
        }
      };
      walk(json, []);
      break;
    }
  }
  return entries;
}

const unquote = (s: string) => (/^(['"]).*\1$/.test(s) ? s.slice(1, -1) : s);

/** Spring 자리표시자 ${PAYMENT_URL:https://api.stripe.com} → 기본값 */
function springDefault(v: string): string {
  const m = /^\$\{[^:}]+:(.*)\}$/.exec(v);
  return m ? m[1]! : v;
}

function stripInlineComment(v: string): string {
  const t = v.trim();
  if (/^["']/.test(t)) return t;
  return t.replace(/\s+#.*$/, '');
}

// appsettings.json의 한 줄 주석(//)과 블록 주석을 지운다. 문자열 안의 https:// 는 그대로 둔다.
function stripJsonComments(s: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += s[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      out += s.slice(i, end < 0 ? s.length : end + 2).replace(/[^\n]/g, ' ');
      i = end < 0 ? s.length : end + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
