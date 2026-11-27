# 분류별 참고: AI 모델 API (ai)

## 호환 API 계열 (drop-in 후보)
- **OpenAI 호환 (Chat Completions)**: OpenRouter, DeepSeek, Groq, Together AI, Fireworks AI, Google Gemini(OpenAI 호환 엔드포인트). OpenAI SDK의 `baseURL`·키·모델 이름만 바꾼다.
  - 보통 되는 것: 채팅 완성, 스트리밍, 도구 호출(모델에 따라 다름).
  - 대개 안 되거나 다른 것: Assistants·Responses API, Realtime, 음성(STT/TTS), 이미지 생성, 파일·배치, 파인튜닝 → 쓰는 기능이면 `no`/`partial`.
  - 모델 이름이 코드에 박혀 있으면(`gpt-4o`) 그 줄은 고쳐야 한다.
- **Azure OpenAI**: 같은 모델이지만 배포 이름·API 버전·인증이 달라 SDK에서 `AzureOpenAI` 클라이언트로 바꾸는 정도의 수정이 필요하다. 저장소에 이미 있으면 `in-repo`.
- **Anthropic Claude**: Amazon Bedrock·Google Vertex AI에서도 같은 모델을 쓰고, Anthropic SDK에 Bedrock·Vertex용 클라이언트가 있다 (클라이언트 생성 줄과 인증 수정).

## 고칠 때 보는 것
- 여러 공급자를 한 레지스트리(설정 파일)로 고르는 코드면 설정 추가만으로 바꿀 수 있는 경우가 많다 → 그 레지스트리가 `repoServices`의 서비스를 이미 지원하는지 본다.
- 임베딩은 모델이 바뀌면 벡터 차원·값이 달라 저장된 벡터를 다시 만들어야 한다 → `note`에 적는다.
