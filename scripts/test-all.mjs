// 내부 테스트 한 번에 돌리기: npm run test:all
//   1) 단위 테스트 (엔진·서버)            Docker test 이미지
//   2) api + Postgres 띄우기               별도 프로젝트(outage-map-test), 호스트 포트 없음
//   3) Postman 컬렉션 (Newman)             실제 공개 저장소를 분석하므로 인터넷 필요
//   4) 정리                                테스트용 컨테이너와 DB 볼륨 삭제 (개발 스택은 그대로)
// GitHub 비인증 한도(IP당 시간당 60회)에 걸리면 .env에 GITHUB_TOKEN을 넣는다.

import { spawnSync } from 'node:child_process';

const compose = ['compose', '-p', 'outage-map-test', '-f', 'docker-compose.yml', '-f', 'docker-compose.test.yml'];

function step(title, args) {
  console.log(`\n▶ ${title}\n  docker ${args.join(' ')}`);
  const started = Date.now();
  const r = spawnSync('docker', args, { stdio: 'inherit' });
  const ok = r.status === 0;
  console.log(`${ok ? '✓' : '✗'} ${title} (${((Date.now() - started) / 1000).toFixed(1)}초)`);
  return ok;
}

const results = [];
try {
  results.push(['단위 테스트', step('단위 테스트', [...compose, '--profile', 'test', 'run', '--rm', '--build', 'test'])]);
  const up = step('api + Postgres 띄우기', [...compose, 'up', '-d', '--build', '--wait', 'api']);
  results.push(['api + Postgres 띄우기', up]);
  if (up) results.push(['Postman (Newman)', step('Postman (Newman)', [...compose, '--profile', 'test', 'run', '--rm', 'newman'])]);
  else step('api 로그', [...compose, 'logs', '--tail', '50', 'api']);
} finally {
  step('정리', [...compose, '--profile', 'test', 'down', '-v', '--remove-orphans']);
}

console.log('\n결과');
for (const [name, ok] of results) console.log(`  ${ok ? '✓' : '✗'} ${name}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
