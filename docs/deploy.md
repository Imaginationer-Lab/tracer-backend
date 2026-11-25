# 실행과 배포

## 로컬 (Docker만 있으면 됨)

```bash
docker compose up -d --build                        # api(:3000) + Postgres 19
docker compose exec db psql -U outage -d outage_map  # DB 직접 보기 (docs/postgres.md)
npm run test:all                                     # 내부 테스트 전체 (아래)
```

### 내부 테스트

`npm run test:all` (= `node scripts/test-all.mjs`) 하나로 단위 테스트 → api·Postgres 띄우기 → Postman 컬렉션(Newman) → 정리까지 돈다.

- 별도 compose 프로젝트(`outage-map-test`)에 호스트 포트 없이 띄우고 끝나면 컨테이너와 DB 볼륨을 지운다. 개발용 스택(:3000)이 떠 있어도 건드리지 않는다.
- Postman 컬렉션은 실제 공개 저장소를 분석하므로 인터넷이 필요하다.
- 따로 돌릴 때: `docker compose --profile test run --rm --build test`(단위), `docker compose --profile test run --rm newman`(개발 스택에 Postman)
- GitHub Actions 같은 CI에는 올리지 않는다 (내부 테스트로만 쓴다).

프론트는 `http://localhost:9000`에서 `http://localhost:3000/api/...`를 부른다. 다른 출처의 브라우저 호출은 403이다 (`CORS_ORIGINS`).

- Postman 앱에서는 `postman/outage-map.postman_collection.json`과 `postman/local.postman_environment.json`을 가져와서 Collection Runner로 순서대로 돌린다. "분석 상태" 요청은 끝날 때까지 스스로 반복한다.
- GitHub 토큰이 없으면 IP당 시간당 60회(분석 1회에 4회)라서 금방 막히고, 큰 저장소에서 필요한 파일만 받는 방식(GraphQL)도 쓰지 못한다. `.env`에 `GITHUB_TOKEN`을 넣는다 (`.env.example` 참고). 토큰에는 아무 권한도 주지 않아도 된다 (공개 저장소만 읽는다).
- Windows 폴더를 컨테이너에 bind mount해서 분석하면 파일 읽기가 매우 느리다 (Ohaasa 기준 8.9초 vs 0.02초). 서버는 GitHub에서 받은 내용을 메모리에서 바로 읽으므로 해당 없다.

## kangdora에 올리기

compose 그대로 올린다. api와 이 서비스 전용 Postgres가 같이 뜨고, Postgres 포트는 밖에 열지 않는다 (compose 네트워크 안에서 api만 붙는다). 온라인 저지가 쓰는 `koj-mysql-compose`와는 완전히 분리된다.

```bash
# kangdora에서
git clone <저장소> outage-map && cd outage-map
cp .env.example .env   # GITHUB_TOKEN, POSTGRES_PASSWORD(새로 만든 긴 값) 채우기
docker compose up -d --build
```

- 2026-11-25 기준 kangdora 여유: 메모리 약 13.5GB, 디스크 56GB. Postgres 컨테이너 하나는 부담이 없다.
- 앞단에 프록시가 있으면 `TRUST_PROXY`를 맞춰야 한다 (아래 "프록시와 TRUST_PROXY").
- 데이터는 `pg-data` 볼륨에 있다. 백업:

```bash
docker compose exec -T db pg_dump -U outage -d outage_map | gzip > outage_map-$(date +%F).sql.gz
```

## 프록시와 TRUST_PROXY

새 분석 요청 제한(IP당 한 번에 3개, 60초마다 1개)은 요청을 보낸 IP로 센다. 프록시를 거치면 백엔드에 직접 연결된 상대는 항상 마지막 프록시라서, 설정하지 않으면 **모든 사용자가 프록시 IP 하나로 보여 한도 하나를 나눠 쓴다.**

실제 사용자 IP는 `X-Forwarded-For`에 담겨 오고, 프록시를 지날 때마다 주소가 하나씩 붙는다. `TRUST_PROXY`는 끝에서부터 믿을 프록시 단계 수다.

| 요청 경로 | `TRUST_PROXY` |
|---|---|
| 브라우저 → 백엔드 (직접) | `false` (기본값) |
| 브라우저 → Cloudflare → 백엔드 | `1` |
| 브라우저 → Cloudflare → 프론트 서버(`/api` 전달) → 백엔드 | `2` |

- **실제 단계 수와 정확히 같아야 한다.** 작으면 프록시 IP로 세서 모두가 한도를 나눠 쓰고, 크면 사용자가 `X-Forwarded-For`를 꾸며 다른 IP인 척하며 요청 제한을 우회할 수 있다.
- 중간 프록시(프론트 서버 포함)가 `X-Forwarded-For`를 **이어 붙여서** 넘겨야 한다. 프론트 서버가 서버 쪽에서 새로 요청을 만들면(헤더를 안 넘기면) 단계 수와 상관없이 사용자 IP를 알 수 없다.
- 백엔드는 프록시를 거쳐서만 들어오게 막는다. 인터넷에서 바로 접속되면 누구나 헤더를 꾸며 보낼 수 있다. compose는 api 포트를 `127.0.0.1`에만 연다.
- 배포 후에 실제 요청에서 백엔드가 보는 IP를 찍어 보고 단계 수를 확인한다.

## 관리형 Postgres로 옮기기 (선택)

코드는 표준 Postgres만 쓰므로 `DATABASE_URL`만 바꾸면 된다. 예: Supabase 프로젝트의 연결 문자열

```
DATABASE_URL=postgres://<user>:<password>@<host>:5432/postgres
```

이때는 compose의 `db` 서비스를 띄우지 않아도 된다 (`docker compose up -d --build api --no-deps`).

## 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `API_HOST_PORT` | 3000 | 호스트에서 여는 포트. `127.0.0.1`에만 묶여서 밖에서는 바로 접속할 수 없다 |
| `DATABASE_URL` | compose의 로컬 Postgres | `postgres://user:pass@host:5432/db` |
| `POSTGRES_PASSWORD` | `outage-local-only` | compose `db` 비밀번호. 서버에서는 반드시 바꾼다 |
| `GITHUB_TOKEN` | 없음 | 권한 없는 토큰으로 충분. 없으면 시간당 60회 |
| `ANALYZER_THREADS` | 2 | 동시에 도는 분석 수 |
| `ANALYZER_QUEUE` | 20 | 대기열 길이. 넘으면 `RATE_LIMITED` |
| `ANALYSIS_TIMEOUT_SECONDS` | 120 | 분석 한 건 시간 상한 |
| `RATE_LIMIT_BURST` · `RATE_LIMIT_REFILL_SECONDS` | 3 · 60 | IP별 새 분석 요청 제한 |
| `TRUST_PROXY` | false | 앞단 프록시 단계 수. Cloudflare만 `1`, Cloudflare + 프론트 서버 `2` ("프록시와 TRUST_PROXY") |
| `CORS_ORIGINS` | `http://localhost:9000,http://127.0.0.1:9000` | 브라우저 호출을 허용할 프론트 출처 (쉼표로 구분) |
| `MAX_REPO_FILES` · `MAX_SOURCE_MB` | 20000 · 100 | 저장소 크기 상한: 파일 수(무시 폴더 제외), 읽을 파일(소스·매니페스트·설정) 크기 합. 이미지·캐시·git 기록은 세지 않는다 |
| `MAX_TARBALL_MB` | 50 | 저장소 전체가 이보다 작으면 tarball 한 번에, 크면 필요한 파일만 받는다. 트리가 잘린 초대형 저장소는 tarball 받는 크기 상한 |
| `ANTHROPIC_API_KEY` | 없음 | **필요.** 외부 서비스 판정(docs/api.md "외부 서비스 탐지"). 없으면 저장된 판정만 쓰고, 처음 보는 후보가 있는 분석은 `DETECTION_UNAVAILABLE`로 실패한다 |
| `CLAUDE_MODEL` | `claude-opus-5-5` | 판정에 쓰는 모델. 바꾸면 분석 캐시 키가 바뀐다 |
| `LLM_TIMEOUT_SECONDS` · `LLM_MAX_ITEMS` | 90 · 600 | 호출 한 번의 시간 상한, 분석 한 번에 묻는 새 후보 수 상한 (많이 쓰인 후보부터, 150개씩 나눠 물음) |
| `CLUE_FIXTURE_FILE` | 없음 | 테스트용. 있으면 AI·DB 대신 이 파일의 고정 판정을 쓴다 (`docker-compose.test.yml`이 `test/fixtures/judgments.json`을 넣음) |
| `DEMO_EVENT_FILE` | `data/demo-event.json` | 데모 재현 이벤트 |
