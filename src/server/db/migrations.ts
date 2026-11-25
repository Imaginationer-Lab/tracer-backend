// 순서대로 한 번씩만 실행된다 (schema_migrations에 기록). 이미 배포된 항목은 고치지 말고 새 항목을 추가한다.
//   ① analyses            저장소·커밋·규칙 버전별 분석 결과 (저장소별 캐시)
//   ② clue_classifications 단서(의존성·host·호출)별 LLM 판정 (모든 저장소 공유)
//   ③ endpoints            공급자 엔드포인트와 상태 페이지 컴포넌트 (모든 저장소 공유)
//      analysis_endpoints  어느 분석의 어느 파일·줄이 그 엔드포인트를 쓰는지
//   ④ learned_rules        검증을 통과한 학습 규칙 (모든 저장소 공유)

export const MIGRATIONS: { id: string; sql: string[] }[] = [
  {
    id: '001_init',
    sql: [
      `CREATE TABLE analyses (
        id              VARCHAR(32)  NOT NULL PRIMARY KEY,
        owner           VARCHAR(100) NOT NULL,
        repo            VARCHAR(100) NOT NULL,
        branch          VARCHAR(255) NOT NULL,
        commit_sha      CHAR(40)     NOT NULL,
        ruleset_version VARCHAR(20)  NOT NULL,
        status          ENUM('running', 'done', 'failed') NOT NULL,
        steps           JSON NOT NULL,
        error           JSON NULL,
        result          JSON NULL,
        details         JSON NULL,
        ambiguous       JSON NULL,
        stats           JSON NULL,
        created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_analyses_commit (owner, repo, commit_sha, ruleset_version),
        KEY ix_analyses_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
      `CREATE TABLE clue_classifications (
        clue_key   VARCHAR(191) NOT NULL PRIMARY KEY,
        kind       ENUM('http', 'host', 'dependency') NOT NULL,
        provider   VARCHAR(40)  NOT NULL,
        service    VARCHAR(100) NULL,
        model      VARCHAR(60)  NULL,
        hits       INT          NOT NULL DEFAULT 0,
        created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
      `CREATE TABLE endpoints (
        id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        endpoint_key CHAR(40)     NOT NULL,
        provider     VARCHAR(40)  NOT NULL,
        host         VARCHAR(255) NOT NULL,
        path         VARCHAR(512) NOT NULL DEFAULT '',
        component    VARCHAR(120) NULL,
        created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_endpoints_key (endpoint_key),
        KEY ix_endpoints_provider (provider)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
      `CREATE TABLE analysis_endpoints (
        analysis_id VARCHAR(32)     NOT NULL,
        endpoint_id BIGINT UNSIGNED NOT NULL,
        file_path   VARCHAR(512)    NOT NULL,
        line        INT             NOT NULL,
        PRIMARY KEY (analysis_id, endpoint_id, file_path(191), line),
        KEY ix_analysis_endpoints_endpoint (endpoint_id),
        CONSTRAINT fk_ae_analysis FOREIGN KEY (analysis_id) REFERENCES analyses (id) ON DELETE CASCADE,
        CONSTRAINT fk_ae_endpoint FOREIGN KEY (endpoint_id) REFERENCES endpoints (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
      `CREATE TABLE learned_rules (
        id          VARCHAR(120) NOT NULL PRIMARY KEY,
        provider    VARCHAR(40)  NOT NULL,
        rule        JSON         NOT NULL,
        verified_on JSON         NULL,
        hits        INT          NOT NULL DEFAULT 0,
        created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    ],
  },
];
