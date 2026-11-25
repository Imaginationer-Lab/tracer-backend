// IP별 토큰 버킷. 캐시에 없는 새 분석을 시작할 때만 토큰을 쓴다.
// 기본: 한 번에 3개까지, 60초마다 1개씩 다시 찬다 (평균 1분에 1회, 행사장처럼 IP를 같이 쓰는 곳도 고려)

import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';

interface Bucket {
  tokens: number;
  updated: number;
}

@Injectable()
export class RateLimiter implements OnModuleDestroy {
  private readonly buckets = new Map<string, Bucket>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    // 꽉 찬 버킷은 기억할 필요가 없다
    this.sweeper = setInterval(() => {
      for (const [ip, b] of this.buckets) if (this.refill(b, Date.now()).tokens >= this.cfg.rateLimit.burst) this.buckets.delete(ip);
    }, 60_000).unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
  }

  /** 토큰을 하나 쓴다. 없으면 다시 시도할 수 있을 때까지 남은 초 */
  take(ip: string, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
    const b = this.refill(this.buckets.get(ip) ?? { tokens: this.cfg.rateLimit.burst, updated: now }, now);
    this.buckets.set(ip, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfter: Math.ceil((1 - b.tokens) * this.cfg.rateLimit.refillSeconds) };
  }

  /** 분석을 시작하지 못했을 때 토큰을 돌려준다 */
  refund(ip: string): void {
    const b = this.buckets.get(ip);
    if (b) b.tokens = Math.min(this.cfg.rateLimit.burst, b.tokens + 1);
  }

  private refill(b: Bucket, now: number): Bucket {
    const gained = (now - b.updated) / 1000 / this.cfg.rateLimit.refillSeconds;
    b.tokens = Math.min(this.cfg.rateLimit.burst, b.tokens + gained);
    b.updated = now;
    return b;
  }
}
