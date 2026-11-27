# 분류별 참고: 모니터링 (monitoring)

## 호환 계열 (drop-in 후보)
- **Sentry SDK 호환**: GlitchTip, Bugsink. Sentry SDK를 그대로 쓰고 DSN만 바꾼다. 성능 추적·세션 리플레이 등은 지원이 적다 → `partial`.
- **OpenTelemetry(OTLP)**: 코드가 OTel SDK로 내보내면 OTLP를 받는 어느 곳으로든 엔드포인트만 바꾼다: Grafana Cloud, Honeycomb, Datadog, New Relic, SigNoz, Jaeger.

## 후보
- 오류 추적: Sentry, Bugsnag, Rollbar, GlitchTip.
- 로그·APM: Datadog, New Relic, Grafana Cloud, Better Stack.

## 고칠 때 보는 것
- 공급자 전용 SDK(Datadog `dd-trace`, New Relic 에이전트)로 붙은 코드는 다른 곳으로 옮기면 초기화 코드를 바꿔야 한다.
