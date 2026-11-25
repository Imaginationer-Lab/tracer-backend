# API 변경: 모든 외부 서비스를 AI로 탐지 (2026-11-25)

백엔드가 공급자별 규칙(Supabase·Stripe·S3 전용 패턴)을 없앤다. 대신 코드에서 외부 호출 후보(외부 패키지 import, HTTP 호출, 호스트, 의존성)를 줄 번호와 함께 모두 뽑고, 각 후보가 어떤 서비스인지는 AI(Claude)가 정한다.

그래서 **탐지되는 서비스가 세 개로 고정되지 않는다.** 엔드포인트, 요청 방법, 단계, 응답의 큰 모양은 그대로이고, 아래 항목만 바뀐다.

> 구현했다. 예시 JSON은 kangdora 서버의 실제 응답이다 (예고 때와 같다). 전체 응답 예시는 `frontend-handoff.md` 3장.

## 프론트가 바꿀 것

| # | 항목 | 지금 | 바뀐 뒤 | 프론트 할 일 |
|---|---|---|---|---|
| 1 | `ProviderId` | `'supabase' \| 'stripe' \| 'aws-s3'` | `string` (소문자·숫자·`-`, 예: `toss-payments`, `sentry`) | 세 값으로 분기하는 코드를 없앤다. 아이콘·색은 `category`로 정한다 |
| 2 | `ProviderCategory` | 4종 | 9종 (아래). 나중에 늘 수 있다 | 모르는 값은 `other`로 처리한다 |
| 3 | `result.providers` | 최대 3개 | 개수 제한 없음 | 목록이 길어질 수 있다 (OpenMAIC 기준 약 30개) |
| 4 | `providers[].role` | 고정 라벨 5종 | AI가 붙인 짧은 한국어 라벨 (예: `결제`, `에러 모니터링`, `AI 모델 호출`) | 그대로 보여 준다 |
| 5 | `result.otherServices` | AI 판단 서비스 | **항상 `[]`** (서비스가 모두 `providers`로 들어옴). 다음 변경 때 필드를 지운다 | 쓰고 있었다면 지운다 |
| 6 | 근거 API `GET /analyses/:id/providers/:providerId` | 세 공급자면 결과에 없어도 `evidence: []` | **이 분석 결과에 있는 서비스만** 받는다. 없으면 `404 PROVIDER_NOT_FOUND` | `result.providers`에 있는 id로만 부른다 |
| 7 | 오류 코드 | 16종 | `DETECTION_UNAVAILABLE` 추가 (`503`, `retryable: true`) | "외부 서비스를 판단하지 못했어요. 잠시 후 다시 시도해 주세요." + 다시 시도 |
| 8 | 분석 시간 | 1~2초 | 처음 보는 후보가 많으면 수 초~수십 초 더 걸림 (같은 후보는 저장해 두고 다시 묻지 않음) | 분석 중 화면이 더 오래 보일 수 있다. 폴링은 그대로 |

### 바뀌지 않는 것

- 엔드포인트 5개, 요청 본문, `steps`(`repo` · `files` · `detect`), `status`, 오류 응답 모양
- `providers[]`의 필드 이름과 뜻: `id`, `name`, `role`, `category`, `fileCount`, `files`, `usage`, `statusSupport`
- `files[]`(파일 트리), `matches[].provider`, `summary`
- 근거 API의 `evidence[]` 모양 (`path`, `line`, `language`, `reason`, `snippet`, `facts`, `endpoint`). 줄 번호는 지금처럼 코드 구조 분석으로 정하고 AI가 짐작하지 않는다.
- 상태 배지: `statusSupport: 'live'`는 지금처럼 Supabase만. 나머지는 `'none'`이라 "실시간 연동 전"
- 데모 재현 이벤트 (`providerId: 'stripe'`)
- 알려진 서비스의 id는 그대로: `supabase`, `stripe`, `aws-s3`

## 타입 (바뀐 부분만)

```ts
/** 서비스 id. 소문자·숫자·하이픈. supabase · stripe · aws-s3 는 지금과 같다 */
export type ProviderId = string;

/** 아이콘·색 고르기용. 모르는 값이 오면 'other'로 취급한다 */
export type ProviderCategory =
  | 'auth'        // 로그인·인증
  | 'payment'     // 결제
  | 'storage'     // 파일 저장·업로드
  | 'database'    // 데이터베이스·BaaS
  | 'ai'          // AI 모델·검색 API
  | 'messaging'   // 메일·SMS·푸시 알림·채팅
  | 'monitoring'  // 에러 추적·로그
  | 'analytics'   // 사용자 분석·광고
  | 'other';      // 지도, 외부 데이터 API 등

export type ErrorCode =
  | /* 지금 16종 */
  | 'DETECTION_UNAVAILABLE'; // 503, retryable: AI 판단 실패 (분석은 status: 'failed', error에 담김)

export interface AnalysisResult {
  providers: ProviderSummary[];     // 모든 외부 서비스
  /** @deprecated 항상 []. 다음 변경 때 지운다 */
  otherServices: [];
  files: FileEntry[];
  summary: { analyzed: number; skipped: number };
}
```

## 정렬

`result.providers` 순서: Supabase → Stripe → Amazon S3(있으면, 디자인 순서 유지) → 나머지는 근거 파일이 많은 순 → 이름순.

## 예시 (실제 응답): 공개 예제 저장소 `Imaginationer-Lab/tracer-demo-store`

예제 저장소에 토스페이먼츠 결제 승인(`src/payments/toss.ts`)이 추가되어, 네 번째 서비스로 나온다.

```json
"providers": [
  { "id": "supabase", "name": "Supabase", "role": "로그인", "category": "auth", "fileCount": 1, "files": [ { "path": "src/auth/login.ts", "line": 2 } ], "usage": "used", "statusSupport": "live" },
  { "id": "stripe", "name": "Stripe", "role": "결제", "category": "payment", "fileCount": 1, "files": [ { "path": "src/payments/checkout.ts", "line": 2 } ], "usage": "used", "statusSupport": "none" },
  { "id": "aws-s3", "name": "Amazon S3", "role": "파일 업로드", "category": "storage", "fileCount": 1, "files": [ { "path": "src/storage/upload.ts", "line": 6 } ], "usage": "used", "statusSupport": "none" },
  { "id": "toss-payments", "name": "Toss Payments", "role": "결제", "category": "payment", "fileCount": 1, "files": [ { "path": "src/payments/toss.ts", "line": 2 } ], "usage": "used", "statusSupport": "none" }
],
"otherServices": []
```

## 실측 (kangdora, 실제 Claude)

| 저장소 | 서비스 | 전체 시간 |
|---|---|---|
| `Imaginationer-Lab/tracer-demo-store` | 4 (Supabase, Stripe, Amazon S3, Toss Payments) | 5초 |
| `JeongWon-CHO/Ohaasa` | 7 (Supabase, Expo Push, OpenAI, 방송국 사이트 3, Resend) | 13초 |
| `BCSDLab/KOIN_WEB_RECODE` | 3 (Sentry, Notion API, Toss Payments) | 14초 |
| `THU-MAIC/OpenMAIC` | 25 (Amazon S3, OpenAI, Anthropic, Bedrock 등) | 48초 |

같은 후보는 판정을 저장해 두므로 두 번째 분석부터는 AI 시간이 줄어든다.

## 화면에 미치는 영향 (참고)

- "탐지된 외부 서비스" 목록 하나로 모든 서비스가 나온다. 따로 "그 밖의 서비스" 영역을 만들 필요가 없다.
- 결제 서비스가 둘(Stripe, Toss Payments)일 수 있다. 디자인 "보류 · 토스페이먼츠 대체 경로"를 살릴 수 있는 데이터가 생긴다.
- 서버에 AI 키가 없거나 AI 호출이 실패해 판단하지 못하면 분석이 `DETECTION_UNAVAILABLE`로 실패한다 (예전처럼 "탐지 결과 없음"으로 보이지 않게).
