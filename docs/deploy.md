# 실행과 배포

## 로컬 (Docker만 있으면 됨)

```bash
docker compose up -d --build                        # api(:3000) + MySQL 8.4
docker compose --profile test run --rm --build test  # 엔진·서버 단위 테스트
docker compose --profile test run --rm newman        # Postman 컬렉션 전체 (api가 떠 있어야 함)
```

- Postman 앱에서는 `postman/outage-map.postman_collection.json`과 `postman/local.postman_environment.json`을 가져와서 Collection Runner로 순서대로 돌린다. "분석 상태" 요청은 끝날 때까지 스스로 반복한다.
- GitHub 토큰이 없으면 IP당 시간당 60회(분석 1회에 3회)라서 금방 막힌다. `.env`에 `GITHUB_TOKEN`을 넣는다 (`.env.example` 참고). 토큰에는 아무 권한도 주지 않아도 된다 (공개 저장소만 읽는다).
- Windows 폴더를 컨테이너에 bind mount해서 분석하면 파일 읽기가 매우 느리다 (Ohaasa 기준 8.9초 vs 0.02초). 서버는 tarball을 메모리에서 읽으므로 해당 없다.

## kangdora MySQL 쓰기

kangdora에는 `koj-mysql-compose` 컨테이너(MySQL 8.4)가 `127.0.0.1:13306`에만 열려 있다 (외부 노출 없음). 온라인 저지가 쓰는 서버라서, 그 안에 이 서비스 전용 DB와 사용자를 따로 만든다.

### 1. DB와 사용자 만들기 (관리자 권한으로 한 번)

```sql
CREATE DATABASE outage_map CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'outage'@'%' IDENTIFIED BY '<새 비밀번호>';
GRANT ALL PRIVILEGES ON outage_map.* TO 'outage'@'%';
```

- 권한은 `outage_map` 데이터베이스 하나로만 준다. 온라인 저지 DB에는 접근할 수 없다.
- 포트가 `127.0.0.1`에만 열려 있어서 `'%'`라도 밖에서는 들어올 수 없다. 접속 경로가 정해지면 `'172.%'` 등으로 더 좁힌다.
- 테이블은 서버가 처음 뜰 때 마이그레이션으로 만든다 (`schema_migrations`에 기록).

### 2-a. 로컬 개발 PC에서 kangdora DB로 붙기 (SSH 터널)

```bash
ssh -N -L 13306:127.0.0.1:13306 kangdora
```

`.env`:

```
DATABASE_URL=mysql://outage:<비밀번호>@host.docker.internal:13306/outage_map
```

`docker compose up -d --build api` (로컬 `db` 서비스는 띄우지 않아도 된다).

### 2-b. kangdora에서 api도 같이 돌리기

같은 호스트라면 터널이 필요 없다. api 컨테이너가 호스트의 `127.0.0.1:13306`에 닿게 하거나, `koj-mysql-compose`가 속한 Docker 네트워크에 api를 붙인다.

```yaml
# docker-compose.override.yml (kangdora 전용)
services:
  api:
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      DATABASE_URL: mysql://outage:<비밀번호>@host.docker.internal:13306/outage_map
```

호스트 게이트웨이로 붙으려면 MySQL 포트가 `127.0.0.1`이 아니라 Docker 브리지에서도 보여야 한다. 그렇지 않으면 네트워크 연결 방식을 쓴다:

```bash
docker network connect <koj 네트워크 이름> outage-map-api-1
# DATABASE_URL=mysql://outage:<비밀번호>@koj-mysql-compose:3306/outage_map
```

## 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `DATABASE_URL` | compose의 로컬 MySQL | `mysql://user:pass@host:port/db` |
| `GITHUB_TOKEN` | 없음 | 권한 없는 토큰으로 충분. 없으면 시간당 60회 |
| `ANALYZER_THREADS` | 2 | 동시에 도는 분석 수 |
| `ANALYZER_QUEUE` | 20 | 대기열 길이. 넘으면 `RATE_LIMITED` |
| `ANALYSIS_TIMEOUT_SECONDS` | 120 | 분석 한 건 시간 상한 |
| `RATE_LIMIT_BURST` · `RATE_LIMIT_REFILL_SECONDS` | 3 · 60 | IP별 새 분석 요청 제한 |
| `TRUST_PROXY` | false | 앞단 프록시 홉 수 (`1` 등) |
| `MAX_TARBALL_MB` · `MAX_REPO_FILES` | 50 · 20000 | 저장소 크기 상한 |
| `DEMO_EVENT_FILE` | `data/demo-event.json` | 데모 재현 이벤트 |
