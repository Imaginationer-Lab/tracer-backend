# 분류별 참고: 기타 (other)

분류가 맞지 않는 서비스(지도, 검색, CDN, 기능 플래그, 소스 호스팅 API 등)에 쓴다.

## 호환 계열 예
- **검색**: Algolia → Typesense(InstantSearch 어댑터 있음), Meilisearch. 검색 UI가 InstantSearch면 고칠 양이 적다.
- **기능 플래그**: OpenFeature SDK로 붙은 코드는 공급자(LaunchDarkly, Flagsmith, PostHog 등)만 바꾼다.
- **지도**: Google Maps ↔ Mapbox ↔ 국내(네이버·카카오) 지도는 SDK가 달라 `rewrite`. 좌표계·약관을 `note`에.

## 대체가 없는 경우
- 그 서비스가 곧 대상 플랫폼인 코드(GitHub API로 GitHub 이슈를 다루는 스크립트, Slack 앱이 Slack API를 부르는 코드)는 대체를 넣지 않는다 (빈 목록).
