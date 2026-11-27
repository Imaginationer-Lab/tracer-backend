// 순서대로 한 번씩만 실행된다 (schema_migrations에 기록). 이미 배포된 항목은 고치지 말고 새 항목을 추가한다.
// Postgres는 DDL도 트랜잭션에 묶이므로, 항목 하나가 중간에 실패하면 통째로 되돌아간다.
//   ① analyses             저장소·커밋·규칙 버전별 분석 결과 (저장소별 캐시)
//   ② clue_classifications 단서(의존성·host·호출)별 LLM 판정 (모든 저장소 공유)
//   ③ endpoints            공급자 엔드포인트와 상태 페이지 컴포넌트 (모든 저장소 공유)
//      analysis_endpoints  어느 분석의 어느 파일·줄이 그 엔드포인트를 쓰는지
//   ④ learned_rules        검증을 통과한 학습 규칙 (모든 저장소 공유)
// 자료형 선택 이유는 docs/postgres.md

export const MIGRATIONS: { id: string; sql: string[] }[] = [
  {
    id: '001_init',
    sql: [
      `CREATE TABLE analyses (
        id              text        PRIMARY KEY,
        owner           text        NOT NULL,
        repo            text        NOT NULL,
        branch          text        NOT NULL,
        commit_sha      char(40)    NOT NULL,
        ruleset_version text        NOT NULL,
        status          text        NOT NULL CHECK (status IN ('running', 'done', 'failed')),
        steps           jsonb       NOT NULL,
        error           jsonb,
        result          jsonb,
        details         jsonb,
        ambiguous       jsonb,
        stats           jsonb,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_analyses_commit UNIQUE (owner, repo, commit_sha, ruleset_version)
      )`,
      // 서버 시작 때 'running'만 찾으므로 그 행만 담는 부분 인덱스
      `CREATE INDEX ix_analyses_running ON analyses (id) WHERE status = 'running'`,
      `CREATE TABLE clue_classifications (
        clue_key   text        PRIMARY KEY,
        kind       text        NOT NULL CHECK (kind IN ('http', 'host', 'dependency')),
        provider   text        NOT NULL,
        service    text,
        model      text,
        hits       integer     NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE endpoints (
        id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        provider   text        NOT NULL,
        host       text        NOT NULL,
        path       text        NOT NULL DEFAULT '',
        component  text,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_endpoints UNIQUE (provider, host, path)
      )`,
      `CREATE TABLE analysis_endpoints (
        analysis_id text    NOT NULL REFERENCES analyses (id) ON DELETE CASCADE,
        endpoint_id bigint  NOT NULL REFERENCES endpoints (id),
        file_path   text    NOT NULL,
        line        integer NOT NULL,
        PRIMARY KEY (analysis_id, endpoint_id, file_path, line)
      )`,
      `CREATE INDEX ix_analysis_endpoints_endpoint ON analysis_endpoints (endpoint_id)`,
      `CREATE TABLE learned_rules (
        id          text        PRIMARY KEY,
        provider    text        NOT NULL,
        rule        jsonb       NOT NULL,
        verified_on jsonb,
        hits        integer     NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now()
      )`,
    ],
  },
  {
    // AI가 외부 서비스를 모두 판정하면서 판정 전체(서비스 id·이름·분류·역할·import 모듈 등)를 저장한다
    id: '002_clue_judgment',
    sql: [`ALTER TABLE clue_classifications ADD COLUMN judgment jsonb`],
  },
  {
    // 서버 목록에 없는 서비스의 상태 페이지를 AI 웹 검색으로 찾고 검증한 결과. 못 찾은 것도 남겨 7일 동안 다시 찾지 않는다
    id: '003_status_sources',
    sql: [
      `CREATE TABLE status_sources (
        service_id text        PRIMARY KEY,
        name       text        NOT NULL,
        page_url   text,
        api_url    text,
        state      text        NOT NULL CHECK (state IN ('verified', 'none')),
        checked_at timestamptz NOT NULL DEFAULT now()
      )`,
    ],
  },
  {
    // 대체 서비스 AI 제안. 키에 파일 경로가 없어서 같은 코드를 쓰는 저장소끼리 같이 쓴다
    id: '004_alternatives',
    sql: [
      `CREATE TABLE alternatives (
        key        text        PRIMARY KEY,
        service_id text        NOT NULL,
        plan       jsonb       NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
    ],
  },
];
