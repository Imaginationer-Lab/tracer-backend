# Postgres 메모 (MySQL에서 넘어오며)

이 프로젝트 코드에서 실제로 MySQL과 다르게 쓴 것만 모았다. 파일: `src/server/db/migrations.ts`, `src/server/db/analysis.repository.ts`

## 직접 들어가 보기

```bash
docker compose exec db psql -U outage -d outage_map
```

| psql 명령 | 뜻 | MySQL에서는 |
|---|---|---|
| `\dt` | 테이블 목록 | `SHOW TABLES;` |
| `\d analyses` | 테이블 구조 | `DESCRIBE analyses;` |
| `\x` | 결과를 세로로 (긴 JSON 볼 때) | `\G` |
| `\q` | 나가기 | `exit` |

## 자료형

| 여기서 쓴 것 | MySQL이라면 | 고른 이유 |
|---|---|---|
| `text` | `VARCHAR(255)` | Postgres는 `text`와 `varchar(n)`의 성능이 같다. 길이 제한이 필요할 때만 `varchar(n)`이나 `CHECK`를 쓴다 |
| `jsonb` | `JSON` | 바이너리로 저장해서 검색·인덱스가 된다 (`@>` 포함 검색, GIN 인덱스) |
| `timestamptz` | `DATETIME(3)` | 항상 UTC로 저장하고 읽을 때 세션 시간대로 보여준다. 시간대 혼동을 막는다 |
| `bigint GENERATED ALWAYS AS IDENTITY` | `AUTO_INCREMENT` | 표준 SQL 방식. 예전 `serial`보다 이쪽을 쓴다 |
| `CHECK (status IN (...))` | `ENUM(...)` | 값을 추가할 때 제약만 바꾸면 된다 (Postgres의 ENUM 타입은 값을 빼기 어렵다) |

## 쿼리

**자리표시자는 `$1, $2`** (MySQL은 `?`)

```ts
pool.query('SELECT * FROM analyses WHERE id = $1', [id]);
```

**UPSERT는 `ON CONFLICT`** (MySQL은 `INSERT IGNORE`, `ON DUPLICATE KEY UPDATE`)

```sql
-- 있으면 무시
INSERT INTO analysis_endpoints (...) VALUES (...) ON CONFLICT DO NOTHING;

-- 있으면 기존 id 돌려받기. DO NOTHING은 충돌 시 RETURNING이 비어서, 아무것도 안 바꾸는 DO UPDATE를 쓴다
INSERT INTO endpoints (provider, host, path) VALUES ($1, $2, $3)
ON CONFLICT ON CONSTRAINT uq_endpoints DO UPDATE SET provider = EXCLUDED.provider
RETURNING id;
```

MySQL에서는 같은 일을 `ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)` 트릭으로 했다.

**`RETURNING`**: `INSERT`·`UPDATE`·`DELETE` 결과 행을 바로 받는다. 다시 `SELECT`할 필요가 없다.

**`updated_at`은 직접 바꾼다**: MySQL의 `ON UPDATE CURRENT_TIMESTAMP`가 없다. `UPDATE ... SET updated_at = now()`로 쓰거나 트리거를 둔다.

**유니크 충돌은 오류 대신 0행으로 받을 수 있다**: `insertRunning`은 `ON CONFLICT ... DO NOTHING` 후 `rowCount`로 "다른 요청이 같은 커밋을 먼저 만들었는지"를 판단한다. MySQL 때는 `ER_DUP_ENTRY` 예외를 잡았다.

## 스키마 변경 (마이그레이션)

**DDL도 트랜잭션에 묶인다.** `CREATE TABLE`을 다섯 개 하다가 네 번째에서 실패하면 앞의 세 개도 되돌아간다. MySQL은 DDL이 자동 커밋이라 중간까지 만들어진 채로 남는다.

## 인덱스

**부분 인덱스**: 조건에 맞는 행만 인덱스에 넣는다. 서버 시작 때 `status = 'running'`인 분석만 찾으므로:

```sql
CREATE INDEX ix_analyses_running ON analyses (id) WHERE status = 'running';
```

**긴 키도 그대로 유니크**: MySQL(utf8mb4)은 인덱스 키가 3072바이트로 제한돼서 엔드포인트에 해시 키(`endpoint_key`)를 따로 뒀다. Postgres는 `UNIQUE (provider, host, path)`를 그대로 건다.

## JSONB 써 보기

```sql
-- Stripe를 쓰는 분석 (포함 검색)
SELECT id, owner, repo FROM analyses WHERE result @> '{"providers":[{"id":"stripe"}]}';

-- 공급자 이름만 펼쳐 보기
SELECT a.repo, p->>'name' AS provider, p->>'role' AS role
FROM analyses a, jsonb_array_elements(a.result->'providers') AS p;

-- 애매 후보가 많은 순
SELECT repo, jsonb_array_length(ambiguous) AS n FROM analyses ORDER BY n DESC NULLS LAST;
```

`->`는 JSON 그대로, `->>`는 텍스트로 꺼낸다. 이런 검색이 많아지면 `CREATE INDEX ... USING gin (result jsonb_path_ops)`로 인덱스를 건다.

## node-pg에서 조심할 것

- JS 배열을 파라미터로 넘기면 **Postgres 배열**로 바뀐다. `jsonb` 컬럼에 넣을 값은 `JSON.stringify`하고 SQL에서 `$1::jsonb`로 받는다.
- `bigint`는 JS 숫자 범위를 넘을 수 있어서 **문자열**로 돌아온다 (`endpoints.id`).
- `jsonb`는 객체로, `timestamptz`는 `Date`로 돌아온다.
