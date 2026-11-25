// 로컬 디렉터리를 분석해서 요약을 출력한다.
//   npx tsx src/cli.ts <dir>            요약
//   npx tsx src/cli.ts <dir> --payload  LLM에 보낼 애매 후보 JSON만

import { toAnalysisResult } from './api/present.js';
import { analyze } from './engine/analyze.js';
import { buildClassificationInput, CLASSIFY_SYSTEM } from './engine/learn.js';
import { loadRepoFromDir } from './engine/load.js';

const [dir, flag] = process.argv.slice(2);
if (!dir) {
  console.error('usage: tsx src/cli.ts <dir> [--payload]');
  process.exit(1);
}

const t0 = performance.now();
const files = loadRepoFromDir(dir);
const t1 = performance.now();
const r = await analyze(files);
const ms = { load: Math.round(t1 - t0), analyze: Math.round(performance.now() - t1) };
const payload = buildClassificationInput(r.ambiguous);

if (flag === '--payload') {
  console.log(payload);
} else {
  const result = toAnalysisResult(r);
  console.log(
    JSON.stringify(
      {
        ms,
        stats: r.stats,
        providers: result.providers,
        evidenceFiles: Object.fromEntries(
          result.providers.map((p) => [p.id, [...new Set(r.evidence.filter((e) => e.provider === p.id && e.kind !== 'manifest').map((e) => `${e.path}:${e.line} ${e.kind}`))]]),
        ),
        ambiguous: r.ambiguous.map(({ occurrences, ...rest }) => ({ ...rest, occurrences: occurrences.length })),
        llm: { systemChars: CLASSIFY_SYSTEM.length, payloadChars: payload.length, payloadBytes: Buffer.byteLength(payload) },
      },
      null,
      2,
    ),
  );
}
