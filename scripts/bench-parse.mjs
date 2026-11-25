// WASM tree-sitter 파싱 속도와 사전 필터(텍스트 단서) 효과를 잰다. 출력은 집계 숫자만.
// docker run --rm -v "$PWD:/app:ro" -v "<저장소>:/corpus:ro" -w /app node:24-slim node scripts/bench-parse.mjs /corpus <이름>
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const require = createRequire(join(process.cwd(), 'package.json'));
const { Parser, Language } = require('@vscode/tree-sitter-wasm');
const wasmDir = require.resolve('@vscode/tree-sitter-wasm').replace(/tree-sitter\.js$/, '');

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.output', '.svelte-kit', '.vercel', '.turbo', '.cache',
  'coverage', 'vendor', 'storybook-static', '__pycache__', '.venv', 'venv', 'site-packages', '.mypy_cache', '.pytest_cache',
  'target', '.gradle', '.idea', 'bin', 'obj', '.vs', 'test', 'tests', '__tests__', '__mocks__', 'e2e', 'cypress', 'testdata']);
const TEST_FILE = /(\.d\.ts|\.(test|spec|stories|e2e)\.[cm]?[jt]sx?|_test\.py|(^|\/)test_[^/]+\.py|Tests?\.(java|cs))$/;
const EXT = { '.ts': 'typescript', '.mts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.java': 'java', '.cs': 'c-sharp' };

// "외부로 나갈 수 있는 코드"의 텍스트 단서. 공급자 이름이 아니라 네트워크·설정 읽기 일반 단서다.
const SIGNAL = new RegExp([
  String.raw`https?://`,
  String.raw`\bfetch\s*\(`, String.raw`\baxios\b`, String.raw`\bky\b`, String.raw`\bgot\(`, String.raw`\$fetch`,
  String.raw`\brequests\.`, String.raw`\bhttpx\b`, String.raw`\baiohttp\b`, String.raw`\burllib\b`, String.raw`\bboto3\b`,
  String.raw`RestTemplate`, String.raw`WebClient`, String.raw`HttpClient`, String.raw`FeignClient`, String.raw`OkHttp`, String.raw`RestClient`,
  String.raw`process\.env`, String.raw`import\.meta\.env`, String.raw`os\.getenv`, String.raw`os\.environ`, String.raw`System\.getenv`,
  String.raw`@Value\(`, String.raw`GetEnvironmentVariable`, String.raw`Configuration\[`, String.raw`_config\[`,
  String.raw`['"\`]@?(?:stripe|@stripe/|@supabase/|supabase|@aws-sdk/)`, String.raw`com\.stripe`, String.raw`software\.amazon`, String.raw`Amazon\.S3`,
  String.raw`using Stripe`, String.raw`using Supabase`,
].join('|'));

function walk(dir, root, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (!IGNORED.has(name)) walk(p, root, out); continue; }
    const rel = relative(root, p).replace(/\\/g, '/');
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    if (!EXT[ext] || TEST_FILE.test(rel) || /\.min\.[cm]?js$/.test(rel)) continue;
    if (st.size > 512 * 1024) { out.skipped++; continue; }
    out.files.push({ rel, lang: EXT[ext], size: st.size, path: p });
  }
}

const [, , dir, label = dir] = process.argv;
const corpus = { files: [], skipped: 0 };
walk(dir, dir, corpus);
for (const f of corpus.files) f.src = readFileSync(f.path, 'utf8');

await Parser.init({ locateFile: (f) => wasmDir + f });
const parsers = {};
for (const lang of new Set(corpus.files.map((f) => f.lang))) {
  const p = new Parser();
  p.setLanguage(await Language.load(`${wasmDir}tree-sitter-${lang}.wasm`));
  parsers[lang] = p;
}

const totalBytes = corpus.files.reduce((s, f) => s + f.size, 0);

let t = performance.now();
const hits = corpus.files.filter((f) => SIGNAL.test(f.src));
const prefilterMs = performance.now() - t;

function run(files, withWalk) {
  let nodes = 0;
  let errors = 0;
  const t0 = performance.now();
  for (const f of files) {
    const tree = parsers[f.lang].parse(f.src);
    if (tree.rootNode.hasError) errors++;
    if (withWalk) {
      // 추출기와 같은 방식(namedChildren 재귀)으로 모든 노드를 방문
      const visit = (n) => { nodes++; n.type; for (const c of n.namedChildren) if (c) visit(c); };
      visit(tree.rootNode);
    }
    tree.delete();
  }
  return { ms: performance.now() - t0, nodes, errors };
}

run(corpus.files.slice(0, 20), false); // 워밍업
const parseAll = run(corpus.files, false);
const walkAll = run(corpus.files, true);
const walkHits = run(hits, true);
const hitBytes = hits.reduce((s, f) => s + f.size, 0);

const mb = (b) => (b / 1024 / 1024).toFixed(2);
console.log(JSON.stringify({
  corpus: label,
  files: corpus.files.length,
  skippedLarge: corpus.skipped,
  sizeMB: +mb(totalBytes),
  prefilter: { ms: +prefilterMs.toFixed(1), hitFiles: hits.length, hitPct: +((hits.length / corpus.files.length) * 100).toFixed(1), hitMB: +mb(hitBytes) },
  parseOnly: { ms: Math.round(parseAll.ms), mbPerSec: +((totalBytes / 1024 / 1024) / (parseAll.ms / 1000)).toFixed(1), filesWithSyntaxErrors: parseAll.errors },
  parseAndWalkAll: { ms: Math.round(walkAll.ms), nodes: walkAll.nodes },
  parseAndWalkPrefiltered: { ms: Math.round(walkHits.ms) },
  rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
}));
