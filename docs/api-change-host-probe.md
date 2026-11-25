# API 변경 예고: 서비스 세부정보에 호스트별 응답 확인 추가 (2026-11-25)

공식 상태 API가 없는 서비스(Stripe, Amazon S3 등)도 "지금 서버가 응답하는지"를 볼 수 있게, 근거 API에 **호스트별 응답 확인(`hosts`)** 을 더한다. 서비스를 눌렀을 때 트리로 펼쳐 보여 주는 용도다.

> 구현 전에 먼저 넘기는 계약이다. 예시 JSON은 예상 값이고, 구현 후 실제 응답으로 바꿔 다시 올린다.

## 프론트가 바꿀 것

| 항목 | 내용 |
|---|---|
| 추가 | `GET /analyses/:id/providers/:providerId` 응답에 `hosts[]` |
| 그대로 | 다른 엔드포인트, 기존 필드 전부. 목록의 상태 배지(`statusSupport`, 공식 상태)도 그대로 |
| 할 일 | 세부정보 패널에 트리 한 단계를 그린다 (안 그려도 깨지지 않음) |

**상태 배지와 섞지 않는다.** 배지는 공급자가 발표한 공식 상태이고, `hosts`는 우리 서버가 직접 요청해 본 결과라 무게가 다르다. Stripe는 목록에서 계속 "실시간 연동 전"이고, 눌렀을 때 세부정보에서 "응답 있음"이 보인다.

## 타입

```ts
export interface HostProbe {
  /** ok: 응답 있음 · error: 응답 이상 · unknown: 확인 불가 */
  result: 'ok' | 'error' | 'unknown';
  /** 화면에 그대로 쓰는 문구: '응답 있음' | '응답 이상' | '확인 불가' */
  label: string;
  /** 참고용 (예: 401). 시간 초과·연결 실패처럼 응답이 없으면 null */
  httpStatus: number | null;
  checkedAt: string;
}

export interface ServiceHost {
  /** 호스트 맨 앞 이름 (api.stripe.com → 'api'). 트리 이름으로 쓴다 */
  name: string;
  host: string;
  probe: HostProbe;
  /** 이 호스트를 부르는 코드 위치. 코드에 주소가 없는 SDK 서비스의 대표 호스트면 [] */
  files: { path: string; line: number }[];
}

export interface ProviderDetail {
  provider: { id: ProviderId; name: string; statusPageUrl: string | null };
  evidence: EvidenceItem[];
  hosts: ServiceHost[];   // 추가. 확인할 호스트가 없으면 []
}
```

## 판정

| `result` | `label` | 언제 |
|---|---|---|
| `ok` | 응답 있음 | 2xx·3xx, 그리고 401·404·405처럼 서버가 정상적으로 거절한 경우 |
| `error` | 응답 이상 | 5xx, 시간 초과(5초), 연결 실패 |
| `unknown` | 확인 불가 | 403·429(상대가 우리를 막음), 우리 서버 네트워크 문제 |

401이 `ok`인 이유: 키 없이 보냈으니 "인증이 필요하다"고 거절한 것이고, 거절할 수 있다는 건 서버가 살아서 요청을 처리한다는 뜻이다. 숫자는 `httpStatus`로 참고용으로만 준다.

## 서버가 확인하는 방법

- **호스트 루트만, 키 없이 GET 한 번** (`https://api.stripe.com/`). 코드의 경로·쿼리는 쓰지 않는다. GET인데 뭔가를 실행하는 주소(확인·웹훅 링크 등)를 건드리지 않기 위해서다. 요청 본문·인증 정보는 보내지 않는다.
- **호스트 단위 캐시 60초, 서버 전체 공유.** 경로가 달라도 호스트가 같으면 한 번만 확인한다. 사용자 수와 상관없이 호스트당 1분에 최대 1번.
- **세부정보를 열 때만** 확인한다 (분석할 때·목록을 볼 때는 보내지 않음).
- **대상 호스트:** 근거의 `endpoint.host` 중 AI가 그 서비스로 판정한 것, 서비스당 최대 3개. 코드에 주소가 없는 SDK 서비스는 대표 호스트 하나 (예: Amazon S3 → `s3.amazonaws.com`).
- **주소 안전장치:** 상태 페이지 검증과 같다. https만, 공개 주소로 풀리는 도메인만, 리다이렉트는 따라가지 않음(3xx는 `ok`).
- **우리 쪽 문제 가려내기:** 실패가 나면 알려진 외부 주소 하나를 같이 확인해서, 그것도 실패하면 `unknown`(확인 불가)으로 둔다.
- `*`가 들어간 호스트(`*.supabase.co`처럼 프로젝트마다 다른 주소)는 실제 주소를 몰라서 확인하지 않는다. 대신 그 서비스는 공식 상태 배지로 본다.

## 예시 (예상): 예제 저장소의 Stripe

```json
{
  "provider": { "id": "stripe", "name": "Stripe", "statusPageUrl": "https://status.stripe.com" },
  "evidence": [ "… 지금과 같음 …" ],
  "hosts": [
    {
      "name": "api",
      "host": "api.stripe.com",
      "probe": { "result": "ok", "label": "응답 있음", "httpStatus": 401, "checkedAt": "2026-11-25T08:41:00Z" },
      "files": [ { "path": "src/payments/checkout.ts", "line": 2 } ]
    }
  ]
}
```

화면 예:

```
Stripe                                  실시간 연동 전
└─ api   api.stripe.com   ● 응답 있음 (401) · 17:41
    └─ src/payments/checkout.ts:2
```

호스트가 여럿이면 (예: OpenAI를 `api.openai.com`과 `files.openai.com`으로 부르는 저장소) 줄이 늘어난다.
