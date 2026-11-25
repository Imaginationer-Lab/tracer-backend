// FEAT-004 데모 재현 이벤트. 파일(DEMO_EVENT_FILE)에서 읽고 검증한다.
// 파일을 바꾸면 재빌드 없이 시나리오를 바꿀 수 있고, 잘못된 파일로 "재현 오류" 화면도 시험할 수 있다.

import { readFile } from 'node:fs/promises';
import { Controller, Get, Inject } from '@nestjs/common';
import type { DemoEvent, ProviderId } from '../../api/contract.js';
import { PROVIDER_IDS } from '../../engine/rules.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ApiException } from '../errors.js';

export function parseDemoEvent(raw: string): DemoEvent {
  let v: Partial<DemoEvent>;
  try {
    v = JSON.parse(raw) as Partial<DemoEvent>;
  } catch {
    throw new ApiException('DEMO_EVENT_INVALID');
  }
  const ok =
    PROVIDER_IDS.includes(v.providerId as ProviderId) &&
    typeof v.title === 'string' &&
    v.title.length > 0 &&
    Number.isInteger(v.httpStatus) &&
    v.httpStatus! >= 100 &&
    v.httpStatus! <= 599 &&
    typeof v.occurredAt === 'string' &&
    !Number.isNaN(Date.parse(v.occurredAt));
  if (!ok) throw new ApiException('DEMO_EVENT_INVALID');
  return { providerId: v.providerId!, title: v.title!, httpStatus: v.httpStatus!, occurredAt: new Date(v.occurredAt!).toISOString() };
}

@Controller('demo-events')
export class DemoController {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  @Get('current')
  async current(): Promise<DemoEvent> {
    const raw = await readFile(this.cfg.demoEventFile, 'utf8').catch(() => {
      throw new ApiException('DEMO_EVENT_INVALID');
    });
    return parseDemoEvent(raw);
  }
}
