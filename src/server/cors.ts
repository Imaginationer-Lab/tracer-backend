// 브라우저에서 API를 부를 수 있는 출처를 프론트(기본 http://localhost:9100)로만 제한한다.
//   - 허용 출처: CORS 헤더를 붙여 응답 (@fastify/cors)
//   - 다른 출처: 403 ORIGIN_NOT_ALLOWED (프리플라이트 포함). 다른 사이트가 방문자 브라우저로 분석을 돌리지 못하게 한다
//   - Origin 헤더가 없는 요청(curl, Postman, 서버 간 호출, 헬스체크)은 브라우저 교차 출처 요청이 아니므로 통과

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ApiException } from './errors.js';

export function isOriginAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  return origin === undefined || allowed.includes(origin);
}

export function applyCors(app: NestFastifyApplication, allowed: readonly string[]): void {
  app.enableCors({
    origin: [...allowed],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
    // RATE_LIMITED 응답의 Retry-After를 프론트가 읽을 수 있게
    exposedHeaders: ['Retry-After'],
    maxAge: 600,
  });
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', async (req, reply) => {
      if (isOriginAllowed(req.headers.origin, allowed)) return;
      const error = new ApiException('ORIGIN_NOT_ALLOWED');
      return reply.status(error.status).send(error.toBody());
    });
}
