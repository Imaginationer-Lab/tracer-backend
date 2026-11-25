import type { ApiError, ErrorCode } from '../api/contract.js';

/** 오류 코드 → HTTP 상태·화면 문구·재시도 가능 여부 (docs/api.md 오류 표와 같다) */
export const ERRORS: Record<ErrorCode, { status: number; message: string; retryable: boolean }> = {
  INVALID_REPO_URL: { status: 400, message: '공개 GitHub 저장소 URL을 입력해 주세요. 예: https://github.com/owner/repo', retryable: false },
  REPO_NOT_ACCESSIBLE: { status: 404, message: '저장소에 접근할 수 없어요. 공개 저장소 주소인지 확인해 주세요.', retryable: false },
  REPO_TOO_LARGE: { status: 413, message: '저장소가 너무 커서 분석할 수 없어요.', retryable: false },
  GITHUB_RATE_LIMITED: { status: 429, message: 'GitHub 요청 한도에 도달했어요.', retryable: false },
  GITHUB_UNAVAILABLE: { status: 502, message: 'GitHub에 일시적으로 연결하지 못했어요. 잠시 후 다시 시도해 주세요.', retryable: true },
  RATE_LIMITED: { status: 429, message: '요청이 많아요. 잠시 후 다시 시도해 주세요.', retryable: true },
  ANALYSIS_NOT_FOUND: { status: 404, message: '분석 결과를 찾을 수 없어요.', retryable: false },
  ANALYSIS_NOT_READY: { status: 409, message: '아직 분석 중이에요.', retryable: true },
  PROVIDER_NOT_FOUND: { status: 404, message: '지원하지 않는 공급자예요.', retryable: false },
  STATUS_NOT_SUPPORTED: { status: 404, message: '이 공급자는 실시간 상태 연동 전이에요.', retryable: false },
  STATUS_UNAVAILABLE: { status: 502, message: '공급자 상태를 확인하지 못했어요.', retryable: true },
  DEMO_EVENT_INVALID: { status: 500, message: '데모 이벤트를 불러오지 못했어요.', retryable: false },
  ORIGIN_NOT_ALLOWED: { status: 403, message: '허용되지 않은 출처에서 온 요청이에요.', retryable: false },
  BAD_REQUEST: { status: 400, message: '요청 형식이 올바르지 않아요.', retryable: false },
  NOT_FOUND: { status: 404, message: '없는 경로예요.', retryable: false },
  INTERNAL_ERROR: { status: 500, message: '서버에서 문제가 생겼어요.', retryable: true },
};

export class ApiException extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly extra: { resetAt?: string; retryAfter?: number; message?: string } = {},
  ) {
    super(extra.message ?? ERRORS[code].message);
  }

  get status(): number {
    return ERRORS[this.code].status;
  }

  toBody(): { error: ApiError } {
    const { status: _status, ...base } = ERRORS[this.code];
    return {
      error: {
        code: this.code,
        ...base,
        message: this.message,
        ...(this.extra.resetAt ? { resetAt: this.extra.resetAt } : {}),
        ...(this.extra.retryAfter !== undefined ? { retryAfter: this.extra.retryAfter } : {}),
      },
    };
  }

  static fromJSON(e: ApiError): ApiException {
    return new ApiException(e.code, { message: e.message, ...(e.resetAt ? { resetAt: e.resetAt } : {}), ...(e.retryAfter !== undefined ? { retryAfter: e.retryAfter } : {}) });
  }
}
