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
- GitHub 토큰이 없으면 IP당 시간당 60회(분석 1회에 3회)라서 금방 막힌다. `.env`에 `GITHUB_TOKEN`을 넣는다 (`.env.example` 참고). 토큰에는 아무 권한도 주지 않아도 된다 (공개 저장소만 읽는다).
- Windows 폴더를 컨테이너에 bind mount해서 분석하면 파일 읽기가 매우 느리다 (Ohaasa 기준 8.9초 vs 0.02초). 서버는 tarball을 메모리에서 읽으므로 해당 없다.

## kangdora에 올리기

compose 그대로 올린다. api와 이 서비스 전용 Postgres가 같이 뜨고, Postgres 포트는 밖에 열지 않는다 (compose 네트워크 안에서 api만 붙는다). 온라인 저지가 쓰는 `koj-mysql-compose`와는 완전히 분리된다.

```bash
# kangdora에서
git clone <저장소> outage-map && cd outage-map
cp .env.example .env   # GITHUB_TOKEN, POSTGRES_PASSWORD(새로 만든 긴 값) 채우기
docker compose up -d --build
```

- 2026-11-25 기준 kangdora 여유: 메모리 약 13.5GB, 디스크 56GB. Postgres 컨테이너 하나는 부담이 없다.
- 앞단에 nginx 같은 프록시를 두면 `TRUST_PROXY=1`로 맞춰야 IP별 요청 제한이 실제 사용자 IP로 동작한다.
- 데이터는 `pg-data` 볼륨에 있다. 백업:

```bash
docker compose exec -T db pg_dump -U outage -d outage_map | gzip > outage_map-$(date +%F).sql.gz
```

## 관리형 Postgres로 옮기기 (선택)

코드는 표준 Postgres만 쓰므로 `DATABASE_URL`만 바꾸면 된다. 예: Supabase 프로젝트의 연결 문자열

```
DATABASE_URL=postgres://<user>:<password>@<host>:5432/postgres
```

이때는 compose의 `db` 서비스를 띄우지 않아도 된다 (`docker compose up -d --build api --no-deps`).

## 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `DATABASE_URL` | compose의 로컬 Postgres | `postgres://user:pass@host:5432/db` |
| `POSTGRES_PASSWORD` | `outage-local-only` | compose `db` 비밀번호. 서버에서는 반드시 바꾼다 |
| `GITHUB_TOKEN` | 없음 | 권한 없는 토큰으로 충분. 없으면 시간당 60회 |
| `ANALYZER_THREADS` | 2 | 동시에 도는 분석 수 |
| `ANALYZER_QUEUE` | 20 | 대기열 길이. 넘으면 `RATE_LIMITED` |
| `ANALYSIS_TIMEOUT_SECONDS` | 120 | 분석 한 건 시간 상한 |
| `RATE_LIMIT_BURST` · `RATE_LIMIT_REFILL_SECONDS` | 3 · 60 | IP별 새 분석 요청 제한 |
| `TRUST_PROXY` | false | 앞단 프록시 홉 수 (`1` 등) |
| `CORS_ORIGINS` | `http://localhost:9000,http://127.0.0.1:9000` | 브라우저 호출을 허용할 프론트 출처 (쉼표로 구분) |
| `MAX_TARBALL_MB` · `MAX_REPO_FILES` | 50 · 20000 | 저장소 크기 상한 |
| `DEMO_EVENT_FILE` | `data/demo-event.json` | 데모 재현 이벤트 |
