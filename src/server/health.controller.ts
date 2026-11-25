import { Controller, Get, Inject } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { DB_POOL } from './db/database.module.js';
import { ApiException } from './errors.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  @Get()
  async check(): Promise<{ status: 'ok'; db: 'ok' }> {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      throw new ApiException('INTERNAL_ERROR', { message: 'DB에 연결할 수 없어요.' });
    }
    return { status: 'ok', db: 'ok' };
  }
}
