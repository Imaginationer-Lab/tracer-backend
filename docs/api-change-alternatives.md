# API 추가 예고: 대체 서비스 (2026-11-27)

장애가 난 서비스를 **가장 적게 고쳐서** 옮길 수 있는 대체 서비스를 알려 준다. 서비스 전체를 비교하지 않는다. 이 저장소가 그 서비스에서 **실제로 쓰는 기능**(호출·엔드포인트·설정 키)만 보고 고른다.

> 구현 전에 먼저 넘기는 계약이다. 예시 JSON은 예상 값이고, 구현 후 실제 응답으로 바꿔 다시 올린다.

## 프론트에 부탁

- **화면에 "AI 제안"이라고 표시해 주세요.** 대체 서비스와 기능 지원 여부는 AI가 정리한 것이고 서버가 직접 검증하지 않는다. 응답에는 따로 표시 필드를 두지 않는다 (항상 AI 제안).
- 처음 부를 때는 몇 초(5~15초) 걸린다. 버튼을 눌렀을 때만 부르고 로딩을 보여 주세요. 같은 서비스·같은 기능이면 그다음부터는 바로 온다.

## 프론트가 바꿀 것

| 항목 | 내용 |
|---|---|
| 추가 | `GET /analyses/:id/providers/:providerId/alternatives` |
| 추가 | 오류 코드 `ALTERNATIVES_UNAVAILABLE` (503, 다시 시도 가능) |
| 그대로 | 다른 엔드포인트, 기존 필드 전부 |

## 타입

```ts
/** 고칠 양이 적은 순: drop-in < in-repo < rewrite */
export type AlternativeFit = 'drop-in' | 'in-repo' | 'rewrite';

export interface UsedFeature {
  /** 기능 식별자 (coverage에서 가리킨다). 예: 'checkout-session' */
  key: string;
  /** 화면 문구. 예: '결제창 생성' */
  label: string;
  /** 이 기능을 쓰는 코드 위치 */
  files: { path: string; line: number }[];
}

export interface Alternative {
  id: ProviderId;
  name: string;
  category: ProviderCategory;
  fit: AlternativeFit;
  /** 화면 문구: '주소·키만 바꾸면 됨' | '저장소에 이미 있음' | '코드 수정 필요' */
  fitLabel: string;
  /** 한 줄 설명 */
  summary: string;
  /** 쓰는 기능마다 대체 서비스에서 되는지. features와 같은 순서 */
  coverage: { feature: string; support: 'yes' | 'partial' | 'no'; note: string | null }[];
  changes: {
    /** 바꿔야 할 설정 키 (환경변수 등) */
    settings: string[];
    /** 고쳐야 할 파일. drop-in이면 대개 [] (설정만 바꿈) */
    files: { path: string; line: number }[];
  };
  /** 대체 서비스의 공식 상태 연동 여부. live면 GET /providers/:id/status로 볼 수 있다 */
  statusSupport: 'live' | 'none';
}

export interface ProviderAlternatives {
  providerId: ProviderId;
  /** 이 저장소가 그 서비스에서 쓰는 기능 */
  features: UsedFeature[];
  /** 최대 3개, 고칠 양이 적은 순. 마땅한 게 없으면 [] */
  alternatives: Alternative[];
  generatedAt: string;
}
```

## 어떻게 고르나

| `fit` | `fitLabel` | 뜻 | 예 |
|---|---|---|---|
| `drop-in` | 주소·키만 바꾸면 됨 | 같은 API·SDK를 받아 준다 | Amazon S3 → Cloudflare R2, OpenAI → OpenRouter |
| `in-repo` | 저장소에 이미 있음 | 이 저장소가 이미 연동한 다른 서비스 | 예제 저장소의 Stripe → Toss Payments |
| `rewrite` | 코드 수정 필요 | 기능은 있지만 호출 코드를 바꿔야 한다 | Stripe → Paddle |

- 정렬: 쓰는 기능이 전부 되는(`no`가 없는) 후보 먼저 → `fit` 순 → `no`가 적은 순 → 고칠 파일이 적은 순. `drop-in`이라도 쓰는 기능 중 안 되는 게 있으면 뒤로 간다.
- 쓰는 기능이 전부 `no`면 넣지 않는다.
- 같은 분류(결제 → 결제)만 고른다. `in-repo`는 서버가 이 분석 결과로 다시 맞춘다 (저장소에 없는데 in-repo라고 하면 rewrite로). 대체가 없는 서비스(예: GitHub API를 쓰는 GitHub 연동)는 `alternatives: []`.

## 캐시·제한

- 결과는 DB에 저장한다. 키는 **서비스 id + 쓰는 호출과 그 코드(파일 경로 제외) + 저장소에 있는 같은 분류 서비스**라, 다른 저장소라도 같은 코드면 같은 결과를 재사용한다. 파일 위치는 응답할 때 이 저장소 것으로 붙인다.
- 저장된 결과가 없어서 새로 만들 때만 IP 사용량(분석 요청과 같은 한도)을 1 쓴다.

## 오류

| 상황 | 상태 | 코드 |
|---|---|---|
| 분석이 없음 / 안 끝남 | 404 / 409 | `ANALYSIS_NOT_FOUND` / `ANALYSIS_NOT_READY` |
| 결과에 없는 서비스 | 404 | `PROVIDER_NOT_FOUND` |
| IP 한도 초과 | 429 | `RATE_LIMITED` |
| AI 응답 실패·시간 초과 | 503 | `ALTERNATIVES_UNAVAILABLE` (`retryable: true`) |

## 예시 (예상): 예제 저장소의 Stripe

예제 저장소는 Stripe를 `src/payments/checkout.ts:2`에서 `api.stripe.com/v1/checkout/sessions`로 부르고, Toss Payments를 이미 `src/payments/toss.ts`에서 쓰고 있다.

```json
{
  "providerId": "stripe",
  "features": [
    { "key": "checkout-session", "label": "결제창 생성", "files": [ { "path": "src/payments/checkout.ts", "line": 2 } ] }
  ],
  "alternatives": [
    {
      "id": "toss-payments",
      "name": "Toss Payments",
      "category": "payment",
      "fit": "in-repo",
      "fitLabel": "저장소에 이미 있음",
      "summary": "이미 src/payments/toss.ts에서 결제 승인을 쓰고 있어 결제창 생성만 옮기면 된다",
      "coverage": [ { "feature": "checkout-session", "support": "yes", "note": "결제위젯 또는 결제창 SDK" } ],
      "changes": { "settings": [], "files": [ { "path": "src/payments/checkout.ts", "line": 2 } ] },
      "statusSupport": "live"
    },
    {
      "id": "paddle",
      "name": "Paddle",
      "category": "payment",
      "fit": "rewrite",
      "fitLabel": "코드 수정 필요",
      "summary": "Checkout 기능이 있지만 요청 형식이 달라 호출 코드를 바꿔야 한다",
      "coverage": [ { "feature": "checkout-session", "support": "yes", "note": null } ],
      "changes": { "settings": ["STRIPE_SECRET_KEY"], "files": [ { "path": "src/payments/checkout.ts", "line": 2 } ] },
      "statusSupport": "none"
    }
  ],
  "generatedAt": "2026-11-27T01:00:00.000Z"
}
```

Amazon S3(예제 저장소는 `src/storage/upload.ts:6`의 `s3.send`로 업로드)는 이렇게 나올 것으로 예상한다:

```json
{
  "id": "cloudflare-r2",
  "name": "Cloudflare R2",
  "fit": "drop-in",
  "fitLabel": "주소·키만 바꾸면 됨",
  "coverage": [ { "feature": "file-upload", "support": "yes", "note": "S3 호환 API" } ],
  "changes": { "settings": ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "S3 endpoint"], "files": [] }
}
```

화면 예:

```
Stripe 대신 쓸 수 있는 서비스                        AI 제안
쓰는 기능: 결제창 생성 (checkout.ts:2)

Toss Payments   저장소에 이미 있음   ● 정상
  결제창 생성 ✓
  고칠 파일: src/payments/checkout.ts:2

Paddle          코드 수정 필요
  결제창 생성 ✓
  바꿀 설정: STRIPE_SECRET_KEY · 고칠 파일: src/payments/checkout.ts:2
```
