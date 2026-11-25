# 장애 지도 API 초안

디자인(figdora `해커톤 캔버스`)의 화면 11개를 기준으로, 화면이 필요로 하는 데이터를 엔드포인트에 연결한 초안이다.
응답 타입은 `src/api/contract.ts`에 있고, 엔진 결과를 응답으로 바꾸는 코드는 `src/api/present.ts`에 있다.

## 전체 흐름

```
SCR-001 입력 ── POST /api/analyses ──────────────▶ 202 { id }   (저장소 확인은 여기서 동기로)
SCR-001 분석 중 ── GET /api/analyses/:id (1초 폴링) ─▶ steps 진행 → status: done
SCR-002 진입 ── GET /api/providers/supabase/status  (statusSupport가 live인 공급자만)
공급자 선택 ── GET /api/analyses/:id/providers/:providerId ─▶ 근거 파일·스니펫·코드 사실
데모 재현 켜기 ── GET /api/demo-events/current ─▶ { providerId: stripe, httpStatus: 503 }
대응 가이드 ── 서버 호출 없음 (이벤트 + 코드 사실로 프론트가 문구 조립)
```

## 화면 ↔ API

| 화면 | 쓰는 API | 쓰는 필드 |
|---|---|---|
| SCR-001 입력 | `POST /api/analyses` | 성공 시 `id`로 이동 |
| SCR-001 · 형식 오류 | 없음 (프론트 검증) | 서버도 같은 규칙으로 `INVALID_REPO_URL` |
| SCR-001 · 조회 오류 3종 | `POST /api/analyses` 오류 | `error.code`, `error.resetAt`, `error.retryable` |
| SCR-001 · 분석 중 | `GET /api/analyses/:id` | `steps[].state` (repo → files → detect) |
| SCR-002 대시보드 | `GET /api/analyses/:id` | `repo.branch`, `repo.commit`(앞 7자리), `result.providers[]`, `result.files[]` |
| 공급자 상태 뱃지 | `GET /api/providers/:id/status` | `state`, `fetchedAt` / 실패 시 "상태 확인 불가 · 다시 조회" |
| 파일 트리 강조 | `GET /api/analyses/:id` | `result.files[].matches[]` (공급자별 줄 번호 → "관련 파일 · 2행") |
| 근거 패널 | `GET /api/analyses/:id/providers/:providerId` | `evidence[].path/line/reason.label/snippet` |
| 대응 가이드 "코드 확인" 줄 | 위와 같음 | `evidence[].facts` (재시도·타임아웃·응답 상태 처리) |
| 일부 파일 실패 | `GET /api/analyses/:id` | `result.summary.skipped`, `files[].state = skipped` |
| 탐지 결과 없음 | `GET /api/analyses/:id` | `result.providers = []` (오류 아님) |
| 데모 재현 · Stripe 근거 없음 | 없음 | 이벤트의 `providerId`가 `result.providers`에 없으면 프론트가 처리 |
| 재현 오류 | `GET /api/demo-events/current` 실패 | `DEMO_EVENT_INVALID` → "재현 끄기" |

## 엔드포인트

### `POST /api/analyses`

```json
{ "repoUrl": "https://github.com/acme/demo-store" }
```

1. URL 형식 검사 (`https://github.com/{owner}/{repo}`, 앞뒤 공백 제거, `.git`·끝 슬래시 허용)
2. **동기로** GitHub 저장소 조회: `GET /repos/{owner}/{repo}` → 기본 브랜치, `GET /repos/{owner}/{repo}/commits/{branch}` → 커밋 SHA
   - 오류는 이 단계에서 바로 응답한다. 그래서 조회 오류 3종이 입력 화면에 그대로 뜬다.
3. `(owner, repo, commit, rulesetVersion)` 캐시가 있으면 `200`으로 완료된 분석을 그대로 돌려준다 (LLM·파싱 0회).
4. 없으면 분석 작업을 만들고 `202`를 준다. 이후 tarball 한 번(`GET /repos/{o}/{r}/tarball/{sha}`)으로 파일을 받는다.
   - 분석 1회당 GitHub API 3회. contents API로 파일을 하나씩 받으면 요청 한도에 바로 걸린다.
   - 서버는 `GITHUB_TOKEN`을 써서 시간당 5,000회 한도로 돌린다 (토큰 없으면 IP당 60회).

```json
// 202
{ "id": "an_7f3k2", "status": "running",
  "repo": { "owner": "acme", "name": "demo-store", "branch": "main", "commit": "a1c3f9e8b2d4..." },
  "steps": [ { "key": "repo", "state": "done" }, { "key": "files", "state": "running" }, { "key": "detect", "state": "pending" } ] }
```

### `GET /api/analyses/:id`

분석 중 화면은 1초 간격으로 폴링한다. 단계 문구("저장소와 기본 브랜치 확인" 등)는 프론트가 `key`로 매핑한다.

```json
{
  "id": "an_7f3k2",
  "status": "done",
  "repo": { "owner": "acme", "name": "demo-store", "branch": "main", "commit": "a1c3f9e8b2d4..." },
  "steps": [ { "key": "repo", "state": "done" }, { "key": "files", "state": "done" }, { "key": "detect", "state": "done" } ],
  "error": null,
  "result": {
    "providers": [
      { "id": "supabase", "name": "Supabase", "role": "로그인", "fileCount": 1, "usage": "used", "statusSupport": "live" },
      { "id": "stripe", "name": "Stripe", "role": "결제", "fileCount": 1, "usage": "used", "statusSupport": "none" },
      { "id": "aws-s3", "name": "Amazon S3", "role": "파일 업로드", "fileCount": 1, "usage": "used", "statusSupport": "none" }
    ],
    "files": [
      { "path": "src/auth/login.ts", "state": "analyzed", "matches": [ { "provider": "supabase", "line": 2 } ] },
      { "path": "src/payments/checkout.ts", "state": "analyzed", "matches": [ { "provider": "stripe", "line": 2 } ] },
      { "path": "src/legacy/bundle.min.js", "state": "skipped", "reason": "minified" },
      { "path": "package.json", "state": "analyzed", "matches": [] },
      { "path": "README.md", "state": "other" }
    ],
    "summary": { "analyzed": 4, "skipped": 1 }
  }
}
```

- `files`는 무시 폴더(`node_modules`, `dist` 등)를 뺀 저장소 경로 전체다. 프론트가 트리를 만들고 `matches`가 있는 파일의 상위 폴더를 펼친다. 경로가 5,000개를 넘으면 `analyzed`·`skipped`만 준다.
- `state`: `analyzed`(읽고 분석함) · `skipped`(분석 대상인데 못 읽음: `too-large` · `minified` · `parse-error`) · `other`(분석 대상 아님, README 등)
- 분석 도중 실패(tarball 다운로드 실패 등)하면 `status: "failed"`이고 `error`는 아래 오류 형식과 같다.

### `GET /api/analyses/:id/providers/:providerId`

공급자를 선택할 때 부른다. 스니펫이 들어 있어서 처음 결과에서는 뺐다.

```json
{
  "provider": { "id": "stripe", "name": "Stripe", "statusPageUrl": "https://status.stripe.com" },
  "evidence": [
    {
      "path": "src/payments/checkout.ts",
      "line": 2,
      "language": "typescript",
      "reason": { "kind": "http", "label": "api.stripe.com 호출" },
      "snippet": { "startLine": 1, "lines": [
        "export function startCheckout(params: URLSearchParams) {",
        "  return fetch('https://api.stripe.com/v1/checkout/sessions', {",
        "    method: 'POST',", "    headers: {", "      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`," ] },
      "facts": { "errorHandling": false, "retry": false, "timeout": false, "statusCheck": false }
    }
  ]
}
```

- `reason.kind`: `call`(SDK 호출) · `http`(HTTP 호출) · `import` · `type`(주입된 클라이언트 타입) · `setting`(환경변수·설정 키 사용) · `config`(설정 파일 값) · `url` · `manifest`(의존성 선언) · `llm`(AI 판단)
- `facts`는 호출부(`call`·`http`)에만 있다. 대응 가이드의 "코드 확인 · checkout.ts에 재시도·타임아웃·응답 상태 처리가 없어요" 줄을 여기서 만든다.
- 분석 결과에 없는 공급자면 `evidence: []`.

### `GET /api/providers/:providerId/status`

FEAT-003. 서버가 공급자 공개 상태 API를 대신 불러서 60초 캐시한다 (브라우저 CORS 회피).

```json
{ "providerId": "supabase", "state": "operational", "description": "All Systems Operational", "fetchedAt": "2026-11-25T01:02:00Z" }
```

- Statuspage `status.indicator` → `none: operational` · `minor: degraded` · `major/critical: outage` · `maintenance: maintenance`
- 조회 실패 → `502 STATUS_UNAVAILABLE` ("상태 확인 불가 · 다시 조회"). 공식 상태를 "정상"으로 대신 채우지 않는다.
- Stripe·S3는 `statusSupport: "none"`이라 프론트가 호출하지 않고 "실시간 연동 전"을 띄운다.

### `GET /api/demo-events/current`

FEAT-004. 서버에 들어 있는 재현 데이터 한 건을 검증해서 돌려준다.

```json
{ "providerId": "stripe", "title": "Stripe 결제 API 응답 실패", "httpStatus": 503, "occurredAt": "2026-11-25T01:00:00Z" }
```

형식이 틀리면 `500 DEMO_EVENT_INVALID`. 재현은 공개 상태를 덮어쓰지 않는다 (프론트 상태로만 표시).

## 오류 형식

```json
{ "error": { "code": "GITHUB_RATE_LIMITED", "message": "GitHub 요청 한도에 도달했어요", "retryable": false, "resetAt": "2026-11-25T01:42:00Z" } }
```

| code | HTTP | 화면 문구 | 다시 시도 버튼 |
|---|---|---|---|
| `INVALID_REPO_URL` | 400 | 형식 오류 (프론트가 먼저 막음) | - |
| `REPO_NOT_ACCESSIBLE` | 404 | 저장소에 접근할 수 없어요 | 없음 |
| `GITHUB_RATE_LIMITED` | 429 | GitHub 요청 한도에 도달했어요 · `resetAt` 시각 | 없음 |
| `GITHUB_UNAVAILABLE` | 502 | GitHub에 일시적으로 연결하지 못했어요 | 있음 (`retryable: true`) |
| `ANALYSIS_NOT_FOUND` | 404 | (만료된 id) 입력 화면으로 | - |
| `STATUS_UNAVAILABLE` | 502 | 상태 확인 불가 · 다시 조회 | 있음 |
| `DEMO_EVENT_INVALID` | 500 | 데모 이벤트를 불러오지 못했어요 | 재현 끄기 |

GitHub 응답 매핑: `404` → `REPO_NOT_ACCESSIBLE` (비공개 저장소도 404) · `403`/`429`에 `x-ratelimit-remaining: 0` → `GITHUB_RATE_LIMITED` (`x-ratelimit-reset`으로 `resetAt`) · `5xx`/네트워크 오류 → `GITHUB_UNAVAILABLE`

## 엔진과 연결

```
tarball → RepoFile[] → analyze() ─▶ EngineResult ─▶ present.ts ─▶ 위 응답들
                                      │
                                      └─ ambiguous[] ─▶ (비동기) LLM 규칙 제안 → 검증 → 규칙 DB
```

- 결과 캐시 키에 `rulesetVersion`을 넣는다. 학습 규칙이 늘면 같은 커밋도 다시 돌리지만, 이건 규칙만 돌리는 것이라 LLM 비용이 없다.
- LLM 규칙 학습은 분석 응답을 막지 않는다. 사용자는 규칙 결과를 바로 보고, 학습된 규칙은 다음 분석부터 반영된다.

## 디자인과 맞춰볼 것

1. **공급자 역할 라벨**(로그인·결제·파일 업로드)은 기능정의서 데이터에 없던 값이다. 엔진이 공급자 기본값 + 호출 경로(Supabase `/auth/*` → 로그인)로 채운다.
2. **`bundle.min.js` "읽기 실패"**: 서버 기준으로는 "건너뜀(축소된 번들)"이다. 헤더의 "읽기 실패 1개"와 알림의 "건너뛰었어요"를 한쪽으로 맞추고, 사유를 툴팁으로 보여주면 좋겠다.
3. **스니펫 범위**: 디자인은 1~5행을 보여준다. 서버는 근거 줄 앞 1줄 ~ 뒤 3줄(최대 5줄)을 준다.
4. **다국어**: 근거마다 `language`가 있어서 구문 강조만 바꾸면 Java·C#·Python 저장소도 같은 화면을 쓴다.
