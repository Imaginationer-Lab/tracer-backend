# 장애 지도 API 초안

디자인(figdora `해커톤 캔버스`)의 화면 11개를 기준으로, 화면이 필요로 하는 데이터를 엔드포인트에 연결한 초안이다.
응답 타입은 `src/api/contract.ts`에 있고, 엔진 결과를 응답으로 바꾸는 코드는 `src/api/present.ts`에 있다.
프론트 구현용 인계 문서는 [`frontend-handoff.md`](frontend-handoff.md), 기계가 읽는 명세는 [`openapi.yaml`](openapi.yaml).

## 전체 흐름

```
SCR-001 입력 ── POST /api/analyses ──────────────▶ 202 { id }   (저장소 확인은 여기서 동기로)
SCR-001 분석 중 ── GET /api/analyses/:id (1초 폴링) ─▶ steps 진행 → status: done
SCR-002 진입 ── GET /api/providers/:id/status  (statusSupport가 live인 서비스만: Supabase, Toss Payments 등)
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
{ "repoUrl": "https://github.com/Imaginationer-Lab/tracer-demo-store" }
```

1. URL 형식 검사 (`https://github.com/{owner}/{repo}`, 앞뒤 공백 제거, `.git`·끝 슬래시 허용)
2. **동기로** GitHub 저장소 조회: `GET /repos/{owner}/{repo}` → 기본 브랜치, `GET /repos/{owner}/{repo}/commits/{branch}` → 커밋 SHA
   - 오류는 이 단계에서 바로 응답한다. 그래서 조회 오류 3종이 입력 화면에 그대로 뜬다.
3. `(owner, repo, commit, rulesetVersion)` 캐시가 있으면 `200`으로 완료된 분석을 그대로 돌려준다 (LLM·파싱 0회).
4. 없으면 **동기로** 트리(`GET /repos/{o}/{r}/git/trees/{sha}?recursive=1`, 경로·크기 목록)를 보고 받을 파일을 정한다.
   - 읽을 파일(소스·매니페스트·설정) 수나 크기 합이 한도(`MAX_REPO_FILES` 20,000개, `MAX_SOURCE_MB` 100MB)를 넘으면 여기서 바로 `413 REPO_TOO_LARGE`. 이미지·영상·의존성 캐시·git 기록 크기는 세지 않는다.
   - 512KB가 넘는 소스는 받지 않고 `skipped`(`too-large`)로 둔다.
5. 분석 작업을 만들고 `202`를 준다. 이후 파일을 받는다.
   - 저장소 전체가 작으면(`MAX_TARBALL_MB` 50MB 이하) tarball 한 번(`GET /repos/{o}/{r}/tarball/{sha}`). 받으면서 바로 풀고 메모리에 통째로 두지 않는다.
   - 크면 필요한 파일만 GraphQL로 받는다 (한 쿼리에 50개, 동시에 8개). 예: KOIN_WEB_RECODE 전체 591MB → 972개 2.8MB, OpenMAIC 131MB → 2,266개 18MB.
   - 트리가 잘릴 만큼 큰 저장소(항목 10만 개 이상)는 tarball로 받고 받는 크기 상한으로 거른다.
   - 분석 1회당 GitHub REST 4회(저장소, 커밋, 트리, tarball) 또는 REST 3회 + GraphQL (파일 50개당 1점, 시간당 5,000점). contents API로 파일을 하나씩 받으면 요청 한도에 바로 걸린다.
   - 서버는 `GITHUB_TOKEN`을 써서 시간당 5,000회 한도로 돌린다 (토큰 없으면 IP당 60회이고, 필요한 파일만 받는 방식은 쓰지 못한다).

```json
// 202
{ "id": "an_60f9b44155d4b902", "status": "running",
  "repo": { "owner": "Imaginationer-Lab", "name": "tracer-demo-store", "branch": "main", "commit": "66eccdfa73f3acf459eccdfbe2f8f1f611fda514" },
  "steps": [ { "key": "repo", "state": "done" }, { "key": "files", "state": "running" }, { "key": "detect", "state": "pending" } ] }
```

### `GET /api/analyses/:id`

분석 중 화면은 1초 간격으로 폴링한다. 단계 문구("저장소와 기본 브랜치 확인" 등)는 프론트가 `key`로 매핑한다.

```json
{
  "id": "an_60f9b44155d4b902",
  "status": "done",
  "repo": { "owner": "Imaginationer-Lab", "name": "tracer-demo-store", "branch": "main", "commit": "66eccdfa73f3acf459eccdfbe2f8f1f611fda514" },
  "steps": [ { "key": "repo", "state": "done" }, { "key": "files", "state": "done" }, { "key": "detect", "state": "done" } ],
  "error": null,
  "result": {
    "providers": [
      { "id": "supabase", "name": "Supabase", "role": "로그인", "category": "auth", "fileCount": 1, "files": [ { "path": "src/auth/login.ts", "line": 2 } ], "usage": "used", "statusSupport": "live" },
      { "id": "stripe", "name": "Stripe", "role": "결제", "category": "payment", "fileCount": 1, "files": [ { "path": "src/payments/checkout.ts", "line": 2 } ], "usage": "used", "statusSupport": "none" },
      { "id": "aws-s3", "name": "Amazon S3", "role": "파일 업로드", "category": "storage", "fileCount": 1, "files": [ { "path": "src/storage/upload.ts", "line": 6 } ], "usage": "used", "statusSupport": "none" },
      { "id": "toss-payments", "name": "Toss Payments", "role": "결제", "category": "payment", "fileCount": 1, "files": [ { "path": "src/payments/toss.ts", "line": 2 } ], "usage": "used", "statusSupport": "live" }
    ],
    "otherServices": [],
    "files": [
      { "path": "package.json", "state": "analyzed", "matches": [] },
      { "path": "README.md", "state": "other" },
      { "path": "src/auth/login.ts", "state": "analyzed", "matches": [ { "provider": "supabase", "line": 2 } ] },
      { "path": "src/payments/checkout.ts", "state": "analyzed", "matches": [ { "provider": "stripe", "line": 2 } ] },
      { "path": "src/payments/toss.ts", "state": "analyzed", "matches": [ { "provider": "toss-payments", "line": 2 } ] },
      { "path": "src/storage/upload.ts", "state": "analyzed", "matches": [ { "provider": "aws-s3", "line": 6 } ] }
    ],
    "summary": { "analyzed": 5, "skipped": 0 }
  }
}
```

- `files`는 무시 폴더(`node_modules`, `dist` 등)를 뺀 저장소 경로 전체다. 프론트가 트리를 만들고 `matches`가 있는 파일의 상위 폴더를 펼친다. 경로가 5,000개를 넘으면 `analyzed`·`skipped`만 준다.
- `state`: `analyzed`(읽고 분석함) · `skipped`(분석 대상인데 못 읽음: `too-large` · `minified` · `parse-error`) · `other`(분석 대상 아님, README 등)
- `providers`: 탐지된 외부 서비스 전부. 서비스는 세 개로 고정되어 있지 않다 (아래 "외부 서비스 탐지"). 순서는 Supabase → Stripe → Amazon S3 → 근거 파일이 많은 순 → 이름순.
- `otherServices`: 항상 `[]` (지울 예정). 예전에 세 공급자 밖 서비스를 따로 담던 자리다.
- 분석 도중 실패(tarball 다운로드 실패 등)하면 `status: "failed"`이고 `error`는 아래 오류 형식과 같다.

### 외부 서비스 탐지 (후보 추출 + AI 판정)

공급자별 내장 규칙은 없다. 탐지는 세 단계다 (`src/engine/learn.ts`, `src/server/llm/clue-classifier.ts`).

1. **1차 분석 (규칙 없음):** 후보만 모은다. 의존성(매니페스트), package.json 없이 import한 npm 패키지, 코드·설정에 나온 호스트, 주소를 못 푼 HTTP 호출. 흔한 라이브러리(react, axios 등)는 비용을 줄이려고 미리 뺀다.
2. **AI 판정 (Claude):** 후보마다 `service`(서비스 id·이름·분류·역할, 의존성이면 import 모듈·클래스 이름) · `library` · `internal` · `unknown`.
   - 보내는 것: 후보 자체(host, 패키지 이름, 호출식과 주소 힌트)만. 파일 경로·줄 번호·코드 전문은 보내지 않는다.
   - 판정은 `clue_classifications.judgment`에 저장해서 다른 저장소에서 같은 후보가 나오면 다시 묻지 않는다.
   - 처음 보는 후보는 150개씩 묶어 동시에 4개까지 묻는다 (`claude-opus-5-5`, effort low).
   - 답은 검증을 통과한 것만 쓴다: 후보 id, 판정 종류, 서비스 id 모양(`^[a-z0-9][a-z0-9-]{0,39}$`), 분류(모르면 `other`), 역할 길이, 패턴 넓이. 알려진 서비스 별칭은 고정 id로 맞춘다 (`amazon-s3` → `aws-s3`).
3. **2차 분석:** 판정을 그 분석에서만 쓰는 규칙(dependency · import · host · type · call · setting)으로 바꿔 엔진을 한 번 더 돌린다. 그래서 줄 번호·호출 추적(1-hop 포함)·코드 사실은 AI가 짐작하지 않고 코드 구조에서 나온다.
   - 주소를 못 푼 HTTP 호출처럼 규칙으로 만들 수 없는 판정은 그 위치에 `reason.kind: "llm"` 근거로 붙는다 (문구 `AI 판단 · …`).

- 처음 보는 후보를 판정하지 못하면(AI 키 없음, 호출 실패·시간 초과) 분석은 `DETECTION_UNAVAILABLE`로 실패한다. "탐지 결과 없음"으로 잘못 보이지 않게 하려는 것이다. 실패한 분석은 캐시하지 않아서 다시 요청하면 다시 시도한다.
- 알려진 서비스(`supabase` · `stripe` · `aws-s3`)는 id·이름·상태 페이지가 고정이다. 상태 연동은 아래 "공개 상태" 참고.
- 실측 (2026-11-25, kangdora):

| 저장소 | 후보 | AI 판정 시간 | 토큰 (입력 · 출력) | 서비스 | 전체 |
|---|---|---|---|---|---|
| `Imaginationer-Lab/tracer-demo-store` | 4 | 2.7초 | 946 · 255 | 4 | 5초 |
| `JeongWon-CHO/Ohaasa` | 39 | 9.8초 | 2,347 · 1,290 | 7 | 13초 |
| `BCSDLab/KOIN_WEB_RECODE` | 34 | 5.8초 | 2,011 · 713 | 3 | 14초 |
| `THU-MAIC/OpenMAIC` | 218 | 24초 | 9,628 · 5,328 | 25 | 48초 |

- 판정 방식(모델, 프롬프트 버전 `CLUE_VERSION`)이나 엔진(`ENGINE_VERSION`)이 바뀌면 캐시 키(`ruleset_version`)가 바뀌어 같은 커밋도 다시 분석한다.

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
        "export function startCheckout(params: URLSearchParams): Promise<Response> {",
        "  return fetch('https://api.stripe.com/v1/checkout/sessions', {",
        "    method: 'POST',", "    headers: {", "      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`," ] },
      "facts": { "errorHandling": false, "retry": false, "timeout": false, "statusCheck": false },
      "endpoint": { "host": "api.stripe.com", "path": "/v1/checkout/sessions" }
    }
  ],
  "hosts": [
    {
      "name": "api",
      "host": "api.stripe.com",
      "probe": { "result": "ok", "label": "응답 있음", "httpStatus": 401, "checkedAt": "2026-11-26T00:55:00.000Z" },
      "files": [ { "path": "src/payments/checkout.ts", "line": 2 } ]
    }
  ]
}
```

- `providers[].files`는 기능정의서의 공통 형식(`providers[].files[].path, line`)이다. 파일 트리 강조는 이것만으로 할 수 있고, 이 API는 스니펫·코드 사실이 필요할 때 부른다.
- `endpoint`는 코드에서 식별한 API 엔드포인트다 (주제 확정 "API 엔드포인트 표시"). host로 판정한 근거에만 있고 SDK 호출은 `null`.

- `reason.kind`: `call`(SDK 호출) · `http`(HTTP 호출) · `import` · `type`(주입된 클라이언트 타입) · `setting`(환경변수·설정 키 사용) · `config`(설정 파일 값) · `url` · `manifest`(의존성 선언) · `llm`(AI 판단)
- `facts`는 호출부(`call`·`http`)에만 있다. 대응 가이드의 "코드 확인 · checkout.ts에 재시도·타임아웃·응답 상태 처리가 없어요" 줄을 여기서 만든다.
- 분석 결과에 없는 공급자면 404 `PROVIDER_NOT_FOUND`.

#### `hosts[]`: 호스트별 응답 확인

공식 상태 API가 없는 서비스(Stripe, Amazon S3 등)도 "지금 서버가 응답하는지"를 보여 준다. **우리 서버가 직접 요청해 본 결과라 공식 상태 배지(`statusSupport`)와 섞지 않는다.**

| `probe.result` | `probe.label` | 언제 |
|---|---|---|
| `ok` | 응답 있음 | 2xx·3xx, 401·404·405 (키 없이 보냈으니 서버가 정상적으로 거절한 것) |
| `error` | 응답 이상 | 5xx, 시간 초과(5초), 연결 실패 |
| `unknown` | 확인 불가 | 403·429(상대가 우리를 막음), 우리 서버 네트워크 문제, 확인하지 않는 주소 |

- 호스트 루트(`https://api.stripe.com/`)에 키·본문 없이 GET 한 번. 코드의 경로·쿼리는 쓰지 않고, 리다이렉트는 따라가지 않는다(3xx는 `ok`).
- 호스트 단위 60초 캐시를 서버 전체가 공유한다. 세부정보를 열 때만 확인한다.
- 대상: 그 서비스 근거의 `endpoint.host` 중 부르는 파일이 많은 순으로 최대 3개. `*`가 들어간 동적 호스트(`*.supabase.co`)는 뺀다. 코드에 주소가 없는 SDK 서비스는 대표 호스트 하나(Stripe → `api.stripe.com`, Amazon S3 → `s3.amazonaws.com`, `files: []`). 확인할 호스트가 없으면 `[]`.
- 주소 안전장치는 상태 페이지 검증과 같다 (https·443만, IP 주소·내부 도메인 거부, DNS가 공개 주소로만 풀려야 함).
- 응답이 없으면 외부 기준 주소를 하나 더 불러서, 그것도 안 되면 `unknown`으로 둔다.

### `GET /api/providers/:providerId/status`

FEAT-003. 서버가 서비스의 공개 상태 API(Statuspage 형식 `/api/v2/status.json`)를 대신 불러서 60초 캐시한다 (브라우저 CORS 회피).

어떤 서비스가 `statusSupport: "live"`인지는 서버가 정한다 (`src/server/providers/`).

1. **서버 목록** (`status-sources.ts`): 공개 상태 API를 직접 확인한 28곳. Supabase, Toss Payments, GitHub, Sentry, OpenAI, Claude(Anthropic), Vercel, Cloudflare, Twilio, SendGrid, Notion, Discord, Expo, Resend, Netlify, MongoDB, Clerk, Linear, Figma, npm, Pusher, Mailgun, Mixpanel, Segment, DigitalOcean, Fly.io, Render, Upstash. AI 판정 id가 같거나 `id-`로 시작하면 맞는다 (`notion-api` → Notion).
2. **처음 보는 서비스**: 분석이 끝나면 백그라운드에서 Claude가 웹 검색으로 공식 상태 페이지 후보를 찾고, 서버가 직접 확인한 것만 `status_sources`에 저장한다. 못 찾은 것도 저장해서 7일 동안 다시 찾지 않는다. 하루 상한 `STATUS_DISCOVERY_DAILY`(100).
   - 찾은 주소는 결국 남의 저장소에서 나온 이름으로 찾은 것이라, 서버가 부르기 전에 막는다: https만, IP 주소 대신 도메인만, 사설·루프백·링크로컬 주소로 풀리면 거부, 경로는 `/api/v2/status.json`만, 리다이렉트는 2번까지 같은 검사, 응답 256KB·5초 상한, Statuspage 모양이어야 통과. 상태를 조회할 때마다 같은 검사를 다시 한다.
- `statusSupport`는 분석 결과를 **읽을 때** 정한다. 분석 직후 `none`이던 서비스도 상태 페이지를 찾으면 다음 조회부터 `live`다.
- 공개 상태 API가 없는 Stripe·AWS는 `none`이다 (Stripe 상태 페이지는 JSON API가 없고, AWS는 HTML만 있다).

```json
{ "providerId": "supabase", "indicator": "none", "state": "operational", "description": "All Systems Operational", "fetchedAt": "2026-11-25T01:02:00Z" }
```

- Statuspage `status.indicator` → `none: operational` · `minor: degraded` · `major/critical: outage` · `maintenance: maintenance`
- 조회 실패 → `502 STATUS_UNAVAILABLE` ("상태 확인 불가 · 다시 조회"). 공식 상태를 "정상"으로 대신 채우지 않는다.
- `statusSupport: "none"`인 서비스는 프론트가 호출하지 않고 "실시간 연동 전"을 띄운다.

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
| `REPO_TOO_LARGE` | 413 | 저장소가 너무 커서 분석할 수 없어요 | 없음 |
| `GITHUB_RATE_LIMITED` | 429 | GitHub 요청 한도에 도달했어요 · `resetAt` 시각 | 없음 |
| `GITHUB_UNAVAILABLE` | 502 | GitHub에 일시적으로 연결하지 못했어요 | 있음 (`retryable: true`) |
| `RATE_LIMITED` | 429 | 요청이 많아요 · `retryAfter`초 뒤 다시 시도 (디자인에 화면 추가 필요) | 있음 |
| `ANALYSIS_NOT_FOUND` | 404 | (만료된 id) 입력 화면으로 | - |
| `ANALYSIS_NOT_READY` | 409 | 아직 분석 중 (상세를 너무 일찍 부름) | 있음 |
| `PROVIDER_NOT_FOUND` | 404 | 이 분석 결과에 없는 서비스 id | - |
| `DETECTION_UNAVAILABLE` | 503 | 외부 서비스를 판단하지 못함 (AI 키 없음, AI 호출 실패) | "외부 서비스를 판단하지 못했어요" + 다시 시도 |
| `STATUS_NOT_SUPPORTED` | 404 | 실시간 연동 전 (`statusSupport: none`인 서비스) | - |
| `STATUS_UNAVAILABLE` | 502 | 상태 확인 불가 · 다시 조회 | 있음 |
| `DEMO_EVENT_INVALID` | 500 | 데모 이벤트를 불러오지 못했어요 | 재현 끄기 |
| `ORIGIN_NOT_ALLOWED` | 403 | (프론트가 아닌 사이트에서 브라우저로 호출) | - |
| `BAD_REQUEST` · `NOT_FOUND` · `INTERNAL_ERROR` | 400 · 404 · 500 | 공통 | `INTERNAL_ERROR`만 있음 |

GitHub 응답 매핑: `404` → `REPO_NOT_ACCESSIBLE` (비공개 저장소도 404) · `403`/`429`에 `x-ratelimit-remaining: 0` → `GITHUB_RATE_LIMITED` (`x-ratelimit-reset`으로 `resetAt`) · `5xx`/네트워크 오류 → `GITHUB_UNAVAILABLE`

**비공개 저장소는 서버 토큰으로 보이더라도 거부한다** (`private: true` → `REPO_NOT_ACCESSIBLE`). 서버 토큰의 권한으로 남의 비공개 코드가 분석되지 않게 하기 위해서다.

## 브라우저 호출 출처 (CORS)

- 브라우저에서 API를 부를 수 있는 곳은 프론트뿐이다. 기본값 `http://localhost:9000` (`127.0.0.1:9000` 포함), `CORS_ORIGINS`(쉼표로 구분)로 바꾼다.
- 허용 출처에는 CORS 헤더를 붙인다: `GET`·`POST`, `Content-Type`, `Retry-After` 노출, 프리플라이트 캐시 600초.
- 다른 출처에서 온 요청(`Origin` 헤더가 있고 목록에 없음)은 프리플라이트를 포함해 `403 ORIGIN_NOT_ALLOWED`로 막는다. 다른 사이트가 방문자의 브라우저로 분석을 돌리지 못하게 하기 위해서다.
- `Origin` 헤더가 없는 요청(curl, Postman, 서버 간 호출, 헬스체크)은 브라우저의 교차 출처 요청이 아니므로 통과한다. CORS는 브라우저 규칙이라, 이런 요청까지 막으려면 인증이나 네트워크 제한이 따로 필요하다.

## 요청 제한

- **새 분석을 시작할 때만** IP별 토큰 버킷을 쓴다. 기본값은 한 번에 3개, 60초마다 1개 충전(`RATE_LIMIT_BURST`, `RATE_LIMIT_REFILL_SECONDS`)이다.
- 세지 않는 것: 캐시 적중(같은 커밋), URL 형식 오류, GitHub 오류, 폴링(`GET`), 상태·데모 조회.
- 1분에 1회로 딱 자르지 않는 이유: 행사장·학교 Wi-Fi는 모두가 공인 IP 하나를 쓰고, "예제 → 오타 → 내 저장소"가 1분 안에 일어난다.
- 사이트 전체 동시 분석 수는 워커 수(`ANALYZER_THREADS`)와 대기열(`ANALYZER_QUEUE`)로 묶는다. 대기열이 차면 IP와 무관하게 `RATE_LIMITED` (`retryAfter: 30`).
- 초과하면 `429 RATE_LIMITED` + `Retry-After` 헤더 + `error.retryAfter`(초).
- 앞단에 프록시를 두면 `TRUST_PROXY`(홉 수)를 맞춰야 실제 IP로 센다. 안 맞추면 모두가 프록시 IP 하나로 보인다.

## 엔진과 연결

```
트리 → tarball 스트림 또는 GraphQL(필요한 파일만) → RepoFile[] → 워커 스레드 analyze() → present.ts → Postgres → 위 응답들
                                       │
                                       ├─ endpoints[] ─▶ endpoints / analysis_endpoints
                                       └─ 1차 ambiguous[] ─▶ Claude 판정 ⇄ clue_classifications
                                                              └─▶ 이번 분석의 규칙 → 2차 analyze()
```

## 저장 (PostgreSQL 19, `src/server/db/migrations.ts`, 자료형 선택은 docs/postgres.md)

| 테이블 | 키 | 범위 | 용도 |
|---|---|---|---|
| `analyses` | 저장소 + 커밋 + `ruleset_version` | 저장소별 | 분석 결과 캐시. 같은 커밋이면 파싱·LLM 0회 |
| `clue_classifications` | 정규화한 후보 (`v2\|dep\|npm\|openai`, `v2\|host\|api.resend.com`) | 모든 저장소 공유 | AI 판정 캐시 (`judgment`에 판정 전체). 토큰을 실제로 줄이는 곳 |
| `endpoints` | 공급자 + host + 경로 | 모든 저장소 공유 | 엔드포인트 → 상태 페이지 컴포넌트 (장애 점검은 여기만 본다, LLM 불필요) |
| `analysis_endpoints` | 분석 + 엔드포인트 + 파일·줄 | 저장소별 | 어느 파일이 그 엔드포인트를 쓰는지 |
| `learned_rules` | 규칙 id | - | 쓰지 않음 (예전 설계: 학습 규칙 저장). 규칙은 분석마다 판정에서 만든다 |

- `ruleset_version`은 `e{ENGINE_VERSION}+ai:{모델}:v{CLUE_VERSION}`이다. 엔진이나 판정 방식이 바뀌면 같은 커밋도 다시 분석한다 (저장된 판정은 그대로 쓰므로 새 후보만 묻는다).
- 서버가 분석 도중 꺼지면, 시작할 때 `running`으로 남은 분석을 실패로 바꾼다. 같은 저장소가 서버를 반복해서 죽이는 일을 막으려고 자동으로 다시 돌리지 않는다.
- `endpoints`는 지금 host로 판정한 근거(직접 HTTP 호출, URL, 설정 값)만 채운다. SDK 호출(`stripe.paymentIntents.create`)을 엔드포인트·컴포넌트로 잇는 표는 아직 없다.

## 디자인과 맞춰볼 것

1. **공급자 역할 라벨**(로그인·결제·파일 업로드)은 기능정의서 데이터에 없던 값이다. 엔진이 공급자 기본값 + 호출 경로(Supabase `/auth/*` → 로그인)로 채운다.
2. **`bundle.min.js` "읽기 실패"**: 서버 기준으로는 "건너뜀(축소된 번들)"이다. 헤더의 "읽기 실패 1개"와 알림의 "건너뛰었어요"를 한쪽으로 맞추고, 사유를 툴팁으로 보여주면 좋겠다.
3. **스니펫 범위**: 디자인은 1~5행을 보여준다. 서버는 근거 줄 앞 1줄 ~ 뒤 3줄(최대 5줄)을 준다.
4. **다국어**: 근거마다 `language`가 있어서 구문 강조만 바꾸면 Java·C#·Python 저장소도 같은 화면을 쓴다.
