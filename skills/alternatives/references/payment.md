# 분류별 참고: 결제 (payment)

## 호환 API
- 결제 API는 사실상 **drop-in 호환이 없다**. Stripe API를 그대로 받는 다른 PG는 없다고 본다. 대부분 `rewrite`이고, 저장소에 이미 다른 PG가 연동돼 있으면 `in-repo`가 가장 쉽다.

## 후보
- 국내: Toss Payments, PortOne(여러 PG를 한 API로), NICEPAY, KG이니시스, KCP.
- 해외: Paddle, Lemon Squeezy(둘 다 판매 대행 MoR: 세금 처리 포함, 정산 방식이 다름), Adyen, Braintree, PayPal, Stripe.

## 기능별로 볼 것
- 결제창(체크아웃 세션) 생성, 결제 승인(confirm), 환불(부분 환불 포함), 정기결제·구독, 웹훅 서명 검증, 고객·카드 저장(빌링키).
- 국내 PG는 "결제창 → 승인 API" 2단계 흐름이 많다. Stripe의 Checkout Session 생성 한 번과 흐름이 다르다 → `partial`과 `note`.
- 웹훅 검증 코드는 서명 방식이 서비스마다 달라 항상 고쳐야 한다.
- 통화·국가 제약: 국내 PG는 원화 중심, 해외 MoR은 국내 사업자 가입 조건이 다를 수 있다 → `note`.
