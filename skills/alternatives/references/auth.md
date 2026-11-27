# 분류별 참고: 로그인·인증 (auth)

## 호환 계열
- **표준 OIDC/OAuth 2.0**으로 붙은 코드(issuer·client id·discovery URL 설정)는 다른 OIDC 공급자로 설정만 바꿔 옮길 수 있다 → `drop-in`. 예: Auth0, Okta, Keycloak(직접 운영), AWS Cognito, Microsoft Entra ID, Google.
- 서비스 전용 SDK(Supabase Auth, Firebase Auth, Clerk)를 쓰는 코드는 대개 `rewrite`.

## 후보
- Supabase Auth, Firebase Authentication, Auth0, Clerk, AWS Cognito, Keycloak, Better Auth·Auth.js(직접 운영 라이브러리).

## 기능별로 볼 것
- 이메일·비밀번호 로그인, 소셜 로그인, 매직 링크·OTP, 세션·토큰 갱신, 사용자 관리 API, 행 수준 보안 연동(Supabase RLS).
- 기존 사용자 이전(비밀번호 해시 가져오기)이 되는지는 서비스마다 다르다 → `note`.
- Supabase는 DB의 RLS 정책이 `auth.uid()`에 기대는 경우가 많아, 인증만 바꾸면 DB 쪽도 손봐야 한다 → `partial`.
