// 모든 오류를 { error: { code, message, retryable, ... } } 한 가지 모양으로 응답한다 (Spring의 @RestControllerAdvice 역할).

import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiException } from './errors.js';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const error = this.toApiException(exception);
    if (error.code === 'INTERNAL_ERROR') this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    if (error.extra.retryAfter !== undefined) void reply.header('Retry-After', String(error.extra.retryAfter));
    void reply.status(error.status).send(error.toBody());
  }

  private toApiException(exception: unknown): ApiException {
    if (exception instanceof ApiException) return exception;
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === 404) return new ApiException('NOT_FOUND');
      if (status === 429) return new ApiException('RATE_LIMITED');
      if (status < 500) return new ApiException('BAD_REQUEST');
    }
    // Fastify 본문 파싱 오류 등
    const statusCode = (exception as { statusCode?: number } | null)?.statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) return new ApiException('BAD_REQUEST');
    return new ApiException('INTERNAL_ERROR');
  }
}
