# 분류별 참고: 분석 (analytics)

## 호환 계열 (drop-in 후보)
- **Segment API 호환**: RudderStack, Jitsu. Segment SDK(`analytics.track/identify`)를 그대로 쓰고 write key·데이터 수집 주소만 바꾼다.
- PostHog·Mixpanel·Amplitude는 각자 SDK라 서로 옮기면 `rewrite`지만, `track(event, props)` 모양이 비슷해 고칠 줄은 적은 편이다.

## 후보
- 제품 분석: PostHog, Mixpanel, Amplitude, Heap.
- 웹 분석: Google Analytics 4, Plausible, Umami(직접 운영 가능).

## 기능별로 볼 것
- 이벤트 기록, 사용자 식별(identify), 기능 플래그(PostHog), 세션 리플레이, 서버 쪽 이벤트.
- 과거 데이터는 옮겨지지 않는다 → `note`.
