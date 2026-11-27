# 분류별 참고: 메시지·알림 (messaging)

## 호환 계열 (drop-in 후보)
- **SMTP로 메일을 보내는 코드**(nodemailer 등)는 어느 SMTP 공급자로든 호스트·계정만 바꾼다: Amazon SES, SendGrid, Mailgun, Postmark, Resend, Brevo.
- **Pusher 프로토콜**: Soketi(직접 운영), Ably(Pusher 호환 어댑터). Pusher 클라이언트·서버 SDK를 그대로 쓰고 호스트·키만 바꾼다.

## 후보
- 메일 API: SendGrid, Mailgun, Postmark, Resend, Amazon SES. 각자 SDK가 달라 API로 붙은 코드는 `rewrite`.
- SMS: Twilio, Vonage, Sinch. 국내: NHN Cloud Notification, 솔라피, 알리고 (발신번호 사전 등록 필요 → `note`).
- 푸시: Firebase Cloud Messaging, APNs, OneSignal.
- 메신저 봇·웹훅: Slack, Discord, Telegram은 서로 형식이 달라 `rewrite`.

## 기능별로 볼 것
- 템플릿 메일(서비스에 저장된 템플릿 id를 쓰는 코드)은 템플릿을 옮겨야 한다 → `partial`.
- 수신·반송 웹훅, 예약 발송, 첨부 파일.
