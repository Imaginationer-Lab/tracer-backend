# 프론트 인계: 장애 지도 백엔드 API

> 이 문서만 보고 프론트(SCR-001 저장소 입력, SCR-002 분석 대시보드)를 구현할 수 있게 쓴 인계 문서다.
> 기계가 읽는 명세는 [`openapi.yaml`](openapi.yaml), 서버 쪽 상세는 [`api.md`](api.md).
> 기준: `Imaginationer-Lab/tracer-backend` `main`, 2026-11-25.
> 4장의 타입을 그대로 쓰는 걸 권장한다. 프론트가 먼저 만든 타입을 꼭 유지해야 할 때만 9장의 어댑터를 쓴다 (정보를 합치지 않게 값을 넓혀서).

## 0. 한 줄 요약

공개 GitHub 저장소 URL을 `POST`하면 백엔드가 저장소를 내려받아 정적 분석으로 외부 서비스(Supabase·Stripe·Amazon S3)와 호출 위치를 찾는다. 프론트는 분석 id로 결과를 폴링해서 대시보드에 보여주고, 공급자를 고르면 근거 코드(스니펫)를 따로 받는다.

## 1. 연결 정보

| 항목 | 값 |
|---|---|
| Base URL | `http://localhost:3000/api` |
| 프론트 출처 | **`http://localhost:9000`에서만** 브라우저 호출 허용 (CORS). 다른 출처는 `403 ORIGIN_NOT_ALLOWED` |
| 인증 | 없음 (로그인·세션 없음) |
| 형식 | 요청·응답 모두 JSON. 요청은 `Content-Type: application/json` |
| 시간 | ISO 8601 UTC 문자열 (`2026-11-25T01:00:00.000Z`). 화면에는 KST로 바꿔 표시 |
| 백엔드 띄우기 | 백엔드 저장소에서 `docker compose up -d --build` → `GET /api/health`가 `{"status":"ok","db":"ok"}` |

## 2. 화면 흐름과 호출 순서

```
[SCR-001 입력]
  사용자가 URL 입력 → 프론트에서 형식 검사 (3-1의 정규식). 틀리면 요청하지 않고 형식 오류 표시
  → POST /analyses { repoUrl }
       202 (새 분석, status: running)  → [SCR-001 분석 중] 으로
       200 (같은 커밋 결과 있음, status: done) → 바로 [SCR-002]
       4xx/5xx → 조회 오류 표시 (5장). 입력값은 유지

[SCR-001 분석 중]
  GET /analyses/:id 를 1초마다 → steps[] 로 진행 표시
       status: done   → [SCR-002]
       status: failed → error 로 조회 오류 표시 (5장)
  150초가 지나도 running이면 멈추고 일시 오류로 표시

[SCR-002 대시보드]  (분석 응답 result 하나로 공급자 목록·파일 트리를 그림)
  statusSupport === 'live' 인 공급자마다 GET /providers/:id/status (Supabase만 해당)
  공급자 선택 → GET /analyses/:id/providers/:providerId (근거 코드·코드 사실)
  데모 재현 켜기 → GET /demo-events/current
  '다른 저장소 분석' → 선택·재현 상태를 초기화하고 [SCR-001]로
```

## 3. 엔드포인트

### 3-1. `POST /analyses` 분석 시작

```json
{ "repoUrl": "https://github.com/acme/demo-store" }
```

- 허용 형식 (앞뒤 공백 제거 후): `^https://github\.com/[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}(\.git)?(/.*)?$`
  - `.git`, 끝 슬래시, `/tree/main/src` 같은 하위 경로도 받는다.
- 서버는 여기서 **동기로** GitHub 저장소와 커밋을 확인한다. 그래서 접근 불가·한도 같은 오류는 이 응답에서 바로 온다.
- 비공개 저장소는 항상 `404 REPO_NOT_ACCESSIBLE`이다.

`202` 새 분석 (실제 응답):

```json
{
  "id": "an_10728fc20ab4eb1b",
  "status": "running",
  "repo": { "owner": "stripe-samples", "name": "checkout-one-time-payments", "branch": "main", "commit": "c834ba3ae155bd77a6aeb5879b58edd6a944af00" },
  "steps": [
    { "key": "repo", "state": "done" },
    { "key": "files", "state": "running" },
    { "key": "detect", "state": "pending" }
  ],
  "error": null,
  "result": null
}
```

`200`: 같은 모양이고 `status: "done"`, `result`가 채워져 있다 (3-2와 같음).

### 3-2. `GET /analyses/:id` 분석 상태·결과

실제 응답 (`stripe-samples/checkout-one-time-payments`, 줄임):

```json
{
  "id": "an_10728fc20ab4eb1b",
  "status": "done",
  "repo": { "owner": "stripe-samples", "name": "checkout-one-time-payments", "branch": "main", "commit": "c834ba3ae155bd77a6aeb5879b58edd6a944af00" },
  "steps": [ { "key": "repo", "state": "done" }, { "key": "files", "state": "done" }, { "key": "detect", "state": "done" } ],
  "error": null,
  "result": {
    "providers": [
      {
        "id": "stripe",
        "name": "Stripe",
        "role": "결제",
        "category": "payment",
        "fileCount": 7,
        "files": [
          { "path": "server/dotnet/Program.cs", "line": 50 },
          { "path": "server/java/src/main/java/com/stripe/sample/Server.java", "line": 52 },
          { "path": "server/nextjs/lib/stripe.ts", "line": 8 }
        ],
        "usage": "used",
        "statusSupport": "none"
      }
    ],
    "files": [
      { "path": "README.md", "state": "other" },
      { "path": "server/nextjs/lib/stripe.ts", "state": "analyzed", "matches": [ { "provider": "stripe", "line": 8 } ] },
      { "path": "server/nextjs/package.json", "state": "analyzed", "matches": [] }
    ],
    "summary": { "analyzed": 35, "skipped": 0 }
  }
}
```

- `steps[].key`의 화면 문구: `repo` 저장소와 기본 브랜치 확인 · `files` 분석할 파일 목록 읽기 · `detect` 외부 서비스 단서 찾기
- `steps[].state`: `pending` · `running` · `done` · `failed`
- `result.providers`: 탐지된 공급자만 담긴다. 순서는 Supabase → Stripe → Amazon S3. 비어 있으면 "탐지 결과 없음" 화면.
- `providers[].files`: 공급자별 근거 파일. 파일마다 대표 줄 하나이고, 강한 근거(호출부) 순이다. **파일 트리 강조와 "관련 파일 · N행"에 이걸 쓴다.**
- `result.files`: 저장소 파일 전체 경로 (무시 폴더 `node_modules` 등은 제외). 트리는 이걸로 만든다.
  - `state`: `analyzed` 분석함 · `skipped` 못 읽음(`reason`: `too-large` · `minified` · `parse-error`) · `other` 분석 대상 아님(README 등)
  - 경로가 5,000개를 넘으면 `other`는 빠진다.
- `usage: "declared-only"`면 의존성 선언만 있고 코드 호출은 못 찾은 것이다.
- 분석이 끝났는지는 `steps`가 아니라 `status`로 판단한다.

### 3-3. `GET /analyses/:id/providers/:providerId` 근거 코드

공급자를 선택할 때 부른다. `providerId`: `supabase` · `stripe` · `aws-s3`

실제 응답 (줄임):

```json
{
  "provider": { "id": "stripe", "name": "Stripe", "statusPageUrl": "https://status.stripe.com" },
  "evidence": [
    {
      "path": "server/dotnet/Program.cs",
      "line": 50,
      "language": "csharp",
      "reason": { "kind": "call", "label": "PriceService 호출" },
      "snippet": {
        "startLine": 49,
        "lines": ["{", "    var priceService = new PriceService();", "    var price = await priceService.GetAsync(stripeOptions.Value.Price);", "", "    return Results.Ok(new"]
      },
      "facts": { "errorHandling": false, "retry": false, "timeout": false, "statusCheck": false },
      "endpoint": null
    }
  ]
}
```

디자인 예제(`src/payments/checkout.ts`)라면 이렇게 나온다:

```json
{
  "path": "src/payments/checkout.ts",
  "line": 2,
  "language": "typescript",
  "reason": { "kind": "http", "label": "api.stripe.com 호출" },
  "snippet": { "startLine": 1, "lines": ["export function startCheckout(params: URLSearchParams) {", "  return fetch('https://api.stripe.com/v1/checkout/sessions', {", "    method: 'POST',", "    headers: {", "      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,"] },
  "facts": { "errorHandling": false, "retry": false, "timeout": false, "statusCheck": false },
  "endpoint": { "host": "api.stripe.com", "path": "/v1/checkout/sessions" }
}
```

- 스니펫은 근거 줄 앞 1줄부터 최대 5줄이다. 줄 번호는 `startLine + index`이고, 강조할 줄은 `line`.
- `reason.kind`: `call`(SDK 호출) · `http`(HTTP 호출) · `import` · `type`(주입된 클라이언트) · `setting`(환경변수·설정 키) · `config`(설정 파일 값) · `url` · `manifest`(의존성 선언) · `llm`(예정)
- `facts`는 호출부(`call`·`http`)에만 있고 나머지는 `null`이다.
- `endpoint`는 host로 판정한 근거에만 있다 (`*`는 동적인 부분, 예: `*.supabase.co`). SDK 호출은 `null`이다.
- 목록은 강한 근거 순이다. 첫 항목이 "여기부터 확인하세요" 대상이다.
- 결과에 없는 공급자를 부르면 `200`에 `evidence: []`가 온다.

### 3-4. `GET /providers/:providerId/status` 공급자 공개 상태

`statusSupport === "live"`인 공급자만 부른다 (지금은 Supabase만). 서버가 60초 캐시한다.

```json
{ "providerId": "supabase", "indicator": "none", "state": "operational", "description": "All Systems Operational", "fetchedAt": "2026-11-25T04:21:02.186Z" }
```

- `state`: `operational` · `degraded` · `outage` · `maintenance` · `unknown` (`indicator`가 Statuspage 원래 값)
- 실패하면 `502 STATUS_UNAVAILABLE` → 그 공급자 행에만 "상태 확인 불가 · 다시 조회". 공급자 목록과 파일 트리는 그대로 쓴다.
- `statusSupport: "none"`인 공급자(Stripe·S3)를 부르면 `404 STATUS_NOT_SUPPORTED`가 온다. 부르지 말고 "실시간 연동 전"을 표시한다.

### 3-5. `GET /demo-events/current` 데모 재현 이벤트

```json
{ "providerId": "stripe", "title": "Stripe 결제 API 응답 실패", "httpStatus": 503, "occurredAt": "2026-11-25T01:00:00.000Z" }
```

- 실패하면 `500 DEMO_EVENT_INVALID` → "데모 이벤트를 불러오지 못했어요" + "재현 끄기"
- 재현은 공개 상태를 덮어쓰지 않는다. 프론트 상태로만 표시한다.

### 3-6. `GET /health`

`{"status":"ok","db":"ok"}`. DB가 안 되면 `500 INTERNAL_ERROR`.

## 4. 타입 (TypeScript)

백엔드 `src/api/contract.ts`와 같다. 그대로 복사해서 써도 된다.

```ts
export type ProviderId = 'supabase' | 'stripe' | 'aws-s3';
export type StepKey = 'repo' | 'files' | 'detect';
export type StepState = 'pending' | 'running' | 'done' | 'failed';

export interface RepoRef { owner: string; name: string; branch: string; commit: string }

export type ErrorCode =
  | 'INVALID_REPO_URL' | 'REPO_NOT_ACCESSIBLE' | 'REPO_TOO_LARGE'
  | 'GITHUB_RATE_LIMITED' | 'GITHUB_UNAVAILABLE' | 'RATE_LIMITED'
  | 'ANALYSIS_NOT_FOUND' | 'ANALYSIS_NOT_READY' | 'PROVIDER_NOT_FOUND'
  | 'STATUS_NOT_SUPPORTED' | 'STATUS_UNAVAILABLE' | 'DEMO_EVENT_INVALID'
  | 'ORIGIN_NOT_ALLOWED' | 'BAD_REQUEST' | 'NOT_FOUND' | 'INTERNAL_ERROR';

export interface ApiError {
  code: ErrorCode;
  message: string;      // 화면에 그대로 써도 되는 한국어 문구
  retryable: boolean;   // true면 "다시 시도" 버튼
  resetAt?: string;     // GITHUB_RATE_LIMITED: 한도가 풀리는 시각
  retryAfter?: number;  // RATE_LIMITED: 다시 시도까지 남은 초 (Retry-After 헤더와 같음)
}
// 오류 응답 본문: { error: ApiError }

export type ProviderCategory = 'auth' | 'payment' | 'storage' | 'database';

export interface ProviderSummary {
  id: ProviderId;
  name: string;
  role: string;                                // 화면용 라벨: 로그인 · 결제 · 파일 업로드 · 데이터베이스 · 파일 저장
  category: ProviderCategory;                  // 기계용 분류 (로그인→auth, 결제→payment, 파일 업로드·파일 저장→storage, 데이터베이스→database)
  fileCount: number;
  files: { path: string; line: number }[];     // 공급자별 근거 파일
  usage: 'used' | 'declared-only';
  statusSupport: 'live' | 'none';
}

export type SkipReason = 'too-large' | 'minified' | 'parse-error';
export type FileEntry =
  | { path: string; state: 'analyzed'; matches: { provider: ProviderId; line: number }[] }
  | { path: string; state: 'skipped'; reason: SkipReason }
  | { path: string; state: 'other' };

export interface AnalysisResult {
  providers: ProviderSummary[];
  files: FileEntry[];
  summary: { analyzed: number; skipped: number };
}

export interface Analysis {
  id: string;
  status: 'running' | 'done' | 'failed';
  repo: RepoRef;
  steps: { key: StepKey; state: StepState }[];
  error: ApiError | null;
  result: AnalysisResult | null;
}

export type EvidenceKind = 'call' | 'http' | 'import' | 'type' | 'setting' | 'config' | 'url' | 'manifest' | 'llm';
export interface CodeFacts { errorHandling: boolean; retry: boolean; timeout: boolean; statusCheck: boolean }

export interface EvidenceItem {
  path: string;
  line: number;
  language: string;
  reason: { kind: EvidenceKind; label: string };
  snippet: { startLine: number; lines: string[] };
  facts: CodeFacts | null;
  endpoint: { host: string; path?: string } | null;
}

export interface ProviderDetail {
  provider: { id: ProviderId; name: string; statusPageUrl: string | null };
  evidence: EvidenceItem[];
}

export interface ProviderStatus {
  providerId: ProviderId;
  indicator: string;
  state: 'operational' | 'degraded' | 'outage' | 'maintenance' | 'unknown';
  description: string;
  fetchedAt: string;
}

export interface DemoEvent { providerId: ProviderId; title: string; httpStatus: number; occurredAt: string }
```

## 5. 오류 처리

| code | HTTP | 언제 | 화면 처리 |
|---|---|---|---|
| `INVALID_REPO_URL` | 400 | URL 형식이 틀림 | 입력란 아래 형식 오류. 프론트 검사로 먼저 막는다 |
| `REPO_NOT_ACCESSIBLE` | 404 | 없음·비공개·빈 저장소 | "저장소에 접근할 수 없어요", 다시 시도 없음 |
| `GITHUB_RATE_LIMITED` | 429 | GitHub 한도 | "GitHub 요청 한도에 도달했어요" + `resetAt`을 `HH:mm`(KST)로 |
| `GITHUB_UNAVAILABLE` | 502 | GitHub 일시 오류 | "일시적으로 연결하지 못했어요" + 다시 시도 |
| `RATE_LIMITED` | 429 | 우리 서버 요청 제한 (IP당 새 분석 3개, 60초마다 1개 충전) | `retryAfter`초 뒤 다시 시도 안내. **디자인에 없는 상태라 문구를 새로 정해야 한다** |
| `REPO_TOO_LARGE` | 413 | 저장소가 너무 큼 / 분석 시간 초과 | 메시지 그대로, 다시 시도 없음 |
| `ANALYSIS_NOT_FOUND` | 404 | 없는 분석 id | 입력 화면으로 |
| `ANALYSIS_NOT_READY` | 409 | 분석 중에 상세를 부름 | `status: done` 이후에 부른다 |
| `STATUS_UNAVAILABLE` | 502 | 상태 API 실패 | 그 공급자에만 "상태 확인 불가 · 다시 조회" |
| `STATUS_NOT_SUPPORTED` | 404 | 연동 전 공급자 | 부르지 않는다 ("실시간 연동 전") |
| `DEMO_EVENT_INVALID` | 500 | 재현 데이터 이상 | "데모 이벤트를 불러오지 못했어요" + 재현 끄기 |
| `ORIGIN_NOT_ALLOWED` | 403 | 9000이 아닌 출처 | 개발 설정 문제 (프론트 포트 확인) |
| `INTERNAL_ERROR` | 500 | 서버 오류 | 일반 오류 + 다시 시도 |

- `error.retryable`이 `true`일 때만 "다시 시도" 버튼을 보인다.
- 분석이 `status: "failed"`로 끝나면 `analysis.error`가 같은 모양이다. 위 표대로 처리한다.
- 조회 오류가 나도 입력값은 유지한다.

## 6. 화면별 구현 규칙

### SCR-001

- 제출 중에는 중복 제출을 막는다 (버튼 비활성).
- "예제 저장소 사용"은 입력란만 채우고 분석은 사용자가 시작한다. 공개 예제 저장소 URL은 아직 정해지지 않았다 (7장).

### SCR-002 상단

- 저장소 `repo.owner/repo.name`, 브랜치 `repo.branch · repo.commit.slice(0, 7)`

### 공급자 목록

- 행 구성: `name` + `role`, "근거 파일 `fileCount`개"
- 상태 뱃지:
  - `statusSupport: 'live'`
    - 조회 중: "조회 중"
    - 성공: `state`를 한국어로 바꿔 표시 (`operational` 정상 · `degraded` 성능 저하 · `outage` 장애 · `maintenance` 점검 중 · `unknown` 상태 확인 불가) + "공식 상태 · HH:mm 조회" (`fetchedAt`)
    - 실패: "상태 확인 불가 · 다시 조회"
  - `statusSupport: 'none'`: "실시간 연동 전" + "공식 상태 미연동"
- 각주: "탐지 결과는 정적 분석 기반의 점검 후보예요. 간접 호출은 누락될 수 있어요."

### 파일 트리

- `result.files`의 경로로 폴더 트리를 만든다.
- 공급자를 선택하면 그 공급자의 `providers[].files` 경로를 강조하고 상위 폴더를 펼친다.
  - 라벨: "관련 파일 · `line`행"
  - 강조는 색과 텍스트를 함께 쓴다.
- 다른 공급자를 고르면 강조를 바꾸고, 선택을 풀면 강조를 지운다.
- `state: 'skipped'` 파일에는 "읽기 실패"를 붙이고, 사유를 툴팁으로 보여준다.
- `summary.skipped > 0`이면 상단에 "일부 파일을 읽지 못했어요 · N개 파일을 건너뛰었어요"를 띄운다.

### 근거 패널

- 공급자를 선택하기 전: "공급자를 선택하면 관련 파일을 볼 수 있어요"
- 선택한 뒤: `GET /analyses/:id/providers/:providerId` 응답의 `evidence[]`를 목록으로 보여준다.
  - 항목: `path:line`, `reason.label`, 스니펫(근거 줄 강조)
  - `endpoint`가 있으면 `host + path`도 함께 표시한다 (예: `api.stripe.com/v1/checkout/sessions`).

### 데모 재현

- 스위치를 켜면 이벤트 카드를 공급자 목록 위에 띄운다.
  - `title`, `HTTP {httpStatus}`, 발생 시각(KST)
  - "데모 재현" 뱃지와 "재현 데이터 · 실제 공개 상태 아님"
- 이벤트와 분석 결과는 `providerId`로 잇는다.
  - 이벤트의 공급자가 `result.providers`에 없으면: "이 저장소에서 Stripe 관련 파일을 찾지 못했어요", 강조 없음
- 스위치를 끄면 카드와 재현으로 생긴 표시를 지운다. 공개 상태는 그대로 둔다.

### 대응 가이드

재현이 켜져 있고, 선택한 공급자가 이벤트의 공급자일 때 근거 패널 아래에 띄운다.

- **응답 코드 비교표:** `401·403` / `429` / `5xx` 행 가운데 `httpStatus`가 속한 행에 "현재"를 표시한다.
- **"먼저 확인":** 공급자 상태 페이지 링크는 `provider.statusPageUrl`을 쓴다.
- **"코드 확인" 줄:** 첫 근거의 `facts`로 만든다. `retry`·`timeout`·`statusCheck`가 모두 `false`면 "코드 확인 · {파일명}에 재시도·타임아웃·응답 상태 처리가 없어요"를 띄운다. 일부만 없으면 없는 것만 나열한다.

## 7. 노션 기획과 맞춘 점 · 다른 점

| 항목 | 상태 |
|---|---|
| 분석 결과 공통 형식 `providers[].files[].path, line` (기능정의서 FEAT-002·005, 주제 확정 "두 작업을 나눌 때 공통 형식") | 맞춤 (`ProviderSummary.files`) |
| 재현 이벤트를 공급자 ID로 탐지 결과와 연결 | 맞춤 (`DemoEvent.providerId`) |
| Supabase 상태 데이터 `providerId, indicator, description, fetchedAt` (FEAT-003) | 맞춤 (+ 화면용 `state`) |
| 재현 데이터 `providerId, occurredAt, httpStatus` (FEAT-004) | 맞춤 (+ 카드 제목 `title`) |
| "코드에서 식별할 수 있는 API 엔드포인트 표시" (주제 확정) | `EvidenceItem.endpoint`. host로 찾은 호출만 있고 SDK 호출은 `null` |
| 잘못된 URL·접근 불가·요청 한도를 구분 (FEAT-001) | 맞춤. 우리 서버 요청 제한 `RATE_LIMITED`가 하나 더 있다 (화면 문구 필요) |
| 탐지 범위: "JS·TS 소스와 package.json" (FEAT-002) | 넓힘. Python·Java·C#, Svelte·Vue, 설정 파일(.env, application.yml, appsettings.json)까지 |
| 역할 라벨·스니펫·코드 사실 | 노션에는 없고 디자인(figdora)에만 있음. 백엔드가 채운다 |
| 재현 데이터 위치: "앱에 포함된 가상 이벤트" / `demo-replay/stripe-503.json` | 백엔드가 `GET /demo-events/current`로 준다. 프론트에 같은 JSON을 넣어 써도 된다 (필드 동일) |
| 공개 예제 저장소 (주제 확정 "게시한 뒤 연결") | **아직 없음.** 예제 소스(`demo-store/`)를 공개 GitHub에 올리고 URL을 "예제 저장소 사용"에 넣어야 한다. 백엔드 테스트 fixture(`test/fixtures/ts-shop`)도 같은 구조(`src/auth/login.ts`, `src/payments/checkout.ts:2`, `src/storage/upload.ts`)다 |
| 빌드 설정(Dockerfile, serverless 설정 등) 읽기 (주제 확정 MVP) | 아직 안 함. 매니페스트와 설정 파일만 읽는다 |
| LLM 분류·요약 | 확장 후보 (기획과 같음). 인터페이스만 있음 |
| Expo 등 오하아사 사례 공급자 | MVP 범위 밖 (기획도 3개 우선) |

## 8. 주의할 점

- `POST /analyses`는 `202`와 `200` 둘 다 성공이다. 본문의 `status`로 분기한다.
- 같은 커밋은 서버가 캐시해서 바로 `200 done`이 온다 (토큰·시간 0).
- 응답 JSON의 키 순서는 보장하지 않는다 (DB가 정렬을 바꿀 수 있음).
- `snippet.lines`에는 탭과 공백이 원문 그대로 들어 있다. 줄바꿈 없이 줄 단위로 렌더링한다.
- 경로 구분자는 항상 `/`, 저장소 루트 기준이다. 줄 번호는 1부터 센다.
- 브라우저에서는 반드시 `http://localhost:9000`에서 띄운다 (`127.0.0.1:9000`도 허용). 다른 포트는 403이다.
- Postman 컬렉션 `postman/outage-map.postman_collection.json`으로 실제 응답을 바로 볼 수 있다.

## 9. 프론트 타입으로 바꾸기 (어댑터)

**권장: 어댑터 없이 4장의 백엔드 타입을 그대로 쓴다.** 그러면 공급자 상태 다섯 가지(정상·성능 저하·장애·점검 중·알 수 없음)와 파일 단위 코드 사실이 그대로 남는다.

이 장은 프론트가 먼저 만든 `AnalysisResult` 계열 타입을 꼭 유지해야 할 때만 쓴다. 그때도 정보를 합치지 말고 프론트 타입의 값을 넓힌다. 특히 상태를 `degraded` 하나로 합치면 "점검 중"(공급자가 미리 알린 작업, 기다리면 됨)과 "장애"(공급자 쪽 문제부터 확인)를 구분할 수 없어서 대응 가이드가 틀어진다.

### 대응표

| 프론트 필드 | 백엔드에서 만드는 법 | 정해 둔 것 |
|---|---|---|
| 결과 받기 | `POST /analyses` → `status`가 `done`이 될 때까지 1초 폴링 | 분석 중 화면은 `steps`로 진행 표시. 150초가 지나면 일시 오류 |
| `repo` | `Analysis.repo` | 그대로 |
| `files: string[]` | `result.files` 중 `state === 'analyzed'`의 `path` | 트리에 README 같은 비분석 파일도 보이려면 `state === 'other'`도 넣는다 |
| `skipped[]` | `result.files` 중 `state === 'skipped'` | 사유 `too-large`→`too_large`, `minified`→`minified`, `parse-error`→`parse_error`. **`fetch_failed`는 생기지 않는다** (서버가 tarball 하나로 받음). 프론트 타입의 `reason`에 `minified`·`parse_error`를 더한다 |
| `providers[].category` | `ProviderSummary.category` 그대로 | `auth`·`payment`·`storage`·`database`. 프론트 타입에 `database`를 더한다. 화면 문구는 `role`(한국어 라벨)을 쓴다 |
| `providers[].files[]` (`path`, `line`, `snippet`) | `GET /analyses/:id/providers/:providerId`의 `evidence[]` (공급자당 1번, 최대 3번) | 순서는 강한 근거 순 (첫 항목이 "여기부터 확인하세요"). 줄 번호를 매기려면 `snippet.startLine`이 필요해서 `snippetStartLine`을 더한다 |
| `providers[].facts` (공급자 단위) | `evidence[].facts` (근거 단위)를 합침 | 호출부가 여러 개면 **전부 처리할 때만 `true`**. `statusHandling` = `statusCheck`. 대응 가이드의 "○○.ts에 … 없어요"처럼 파일 이름이 필요하면 근거 단위 `facts`를 그대로 쓴다 |
| `AnalyzeError.kind` | `error.code` | `REPO_NOT_ACCESSIBLE`→`not_found`, `GITHUB_RATE_LIMITED`→`rate_limited`(`resetAt`), 그 밖은 `temporary`. 백엔드에만 있는 것: `INVALID_REPO_URL`→`invalid_url`, `REPO_TOO_LARGE`→`too_large`, 우리 서버 요청 제한 `RATE_LIMITED`→`busy`(`retryAfter`초). 이 세 값을 프론트 타입에 더한다 |
| `ProviderStatus.state` | `state` 그대로 | **합치지 않는다.** 프론트 타입의 `state`를 `operational`·`degraded`·`outage`·`maintenance`·`unknown`으로 넓힌다 (화면: 정상·성능 저하·장애·점검 중·상태 확인 불가). 조회 실패(`502 STATUS_UNAVAILABLE`)는 `unknown` |

어댑터로 바꾸면서 버리는 것: `endpoint`, `reason.label`/`kind`, `language`, `usage`, `statusSupport`, `fileCount`. 화면에 필요해지면 그때 꺼내 쓴다. 특히 `statusSupport`는 "실시간 연동 전" 표시와 상태 API 호출 여부에 필요하다.

### 예시 코드

4장 타입을 `contract.ts`로 두고 그대로 쓸 수 있다 (strict 타입 검사 통과).

```ts
import type { Analysis, ApiError, ErrorCode, ProviderCategory, ProviderDetail, ProviderId, ProviderStatus } from './contract.js'; // 4장 타입

// 프론트 타입 (원래 정의에서 값만 넓힘: skipped.reason, category(database), AnalyzeError.kind, snippetStartLine, 상태 다섯 가지)
export type FrontAnalysisResult = {
  repo: { owner: string; name: string; branch: string; commit: string };
  files: string[];
  skipped: { path: string; reason: 'too_large' | 'minified' | 'parse_error' }[];
  providers: {
    id: ProviderId;
    name: string;
    category: ProviderCategory;
    files: { path: string; line: number; snippet: string[]; snippetStartLine: number }[];
    facts?: { retry: boolean; timeout: boolean; statusHandling: boolean };
  }[];
};
export type AnalyzeError = {
  kind: 'not_found' | 'rate_limited' | 'temporary' | 'invalid_url' | 'too_large' | 'busy';
  message: string;
  resetAt?: string;
  retryAfter?: number;
};
// 상태는 합치지 않는다: 정상·성능 저하·장애·점검 중·알 수 없음
export type FrontProviderStatus = { providerId: ProviderId; state: ProviderStatus['state']; description: string; fetchedAt: string };

const API = 'http://localhost:3000/api';

export class AnalyzeFailure extends Error {
  constructor(readonly error: AnalyzeError) {
    super(error.message);
  }
}

const KIND: Partial<Record<ErrorCode, AnalyzeError['kind']>> = {
  REPO_NOT_ACCESSIBLE: 'not_found',
  GITHUB_RATE_LIMITED: 'rate_limited',
  RATE_LIMITED: 'busy', // 우리 서버 요청 제한 (retryAfter초 뒤 다시)
  INVALID_REPO_URL: 'invalid_url',
  REPO_TOO_LARGE: 'too_large',
};

export function toAnalyzeError(e: ApiError): AnalyzeError {
  return {
    kind: KIND[e.code] ?? 'temporary',
    message: e.message,
    ...(e.resetAt ? { resetAt: e.resetAt } : {}),
    ...(e.retryAfter !== undefined ? { retryAfter: e.retryAfter } : {}),
  };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { 'Content-Type': 'application/json' } });
  const body: unknown = await res.json();
  if (!res.ok) throw new AnalyzeFailure(toAnalyzeError((body as { error: ApiError }).error));
  return body as T;
}

const REASON = { 'too-large': 'too_large', minified: 'minified', 'parse-error': 'parse_error' } as const;

/** POST → 1초 폴링 → 공급자 상세(최대 3번) → 프론트 타입 */
export async function analyze(repoUrl: string, onSteps?: (steps: Analysis['steps']) => void): Promise<FrontAnalysisResult> {
  let a = await call<Analysis>('/analyses', { method: 'POST', body: JSON.stringify({ repoUrl: repoUrl.trim() }) });
  const deadline = Date.now() + 150_000;
  while (a.status === 'running') {
    onSteps?.(a.steps);
    if (Date.now() > deadline) throw new AnalyzeFailure({ kind: 'temporary', message: '분석이 너무 오래 걸려요. 잠시 후 다시 시도해 주세요.' });
    await new Promise((r) => setTimeout(r, 1000));
    a = await call<Analysis>(`/analyses/${a.id}`);
  }
  if (a.status === 'failed' || !a.result) {
    throw new AnalyzeFailure(toAnalyzeError(a.error ?? { code: 'INTERNAL_ERROR', message: '분석에 실패했어요.', retryable: true }));
  }
  const { id, repo, result } = { id: a.id, repo: a.repo, result: a.result };
  const details = await Promise.all(result.providers.map((p) => call<ProviderDetail>(`/analyses/${id}/providers/${p.id}`)));

  return {
    repo,
    files: result.files.filter((f) => f.state === 'analyzed').map((f) => f.path),
    skipped: result.files.flatMap((f) => (f.state === 'skipped' ? [{ path: f.path, reason: REASON[f.reason] }] : [])),
    providers: result.providers.map((p, i) => {
      const evidence = details[i]!.evidence;
      const facts = evidence.flatMap((e) => (e.facts ? [e.facts] : []));
      return {
        id: p.id,
        name: p.name,
        category: p.category,
        // 근거는 강한 순서. 첫 항목이 "여기부터 확인하세요"
        files: evidence.map((e) => ({ path: e.path, line: e.line, snippet: e.snippet.lines, snippetStartLine: e.snippet.startLine })),
        // 호출부가 여러 개면 "전부 처리할 때만 true" (하나라도 빠지면 대응 가이드에 표시)
        ...(facts.length
          ? { facts: { retry: facts.every((f) => f.retry), timeout: facts.every((f) => f.timeout), statusHandling: facts.every((f) => f.statusCheck) } }
          : {}),
      };
    }),
  };
}

/** Supabase처럼 statusSupport === 'live'인 공급자만 부른다. 조회 실패(502)는 unknown */
export async function providerStatus(providerId: ProviderId): Promise<FrontProviderStatus> {
  try {
    const s = await call<ProviderStatus>(`/providers/${providerId}/status`);
    return { providerId, state: s.state, description: s.description, fetchedAt: s.fetchedAt };
  } catch {
    return { providerId, state: 'unknown', description: '상태 확인 불가', fetchedAt: new Date().toISOString() };
  }
}
```
