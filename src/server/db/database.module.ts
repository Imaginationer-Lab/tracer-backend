import { Global, Inject, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { MIGRATIONS } from './migrations.js';

export const DB_POOL = Symbol('DB_POOL');

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      inject: [APP_CONFIG],
      // pg는 jsonb 컬럼을 객체로, timestamptz를 Date로 돌려준다
      useFactory: (cfg: AppConfig): pg.Pool => new pg.Pool({ connectionString: cfg.databaseUrl, max: 10 }),
    },
  ],
  exports: [DB_POOL],
})
export class DatabaseModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Database');

  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  async onModuleInit(): Promise<void> {
    await this.waitForDatabase();
    await this.migrate();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }

  /** compose에서 DB가 늦게 뜰 수 있어서 잠깐 기다린다 */
  private async waitForDatabase(attempts = 30): Promise<void> {
    for (let i = 1; ; i++) {
      try {
        await this.pool.query('SELECT 1');
        return;
      } catch (err) {
        if (i >= attempts) throw err;
        this.logger.warn(`DB 연결 대기 중 (${i}/${attempts}): ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private async migrate(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      // DDL까지 한 트랜잭션: 중간에 실패하면 이 항목 전체가 되돌아간다
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        for (const sql of m.sql) await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
        await client.query('COMMIT');
        this.logger.log(`migration ${m.id} 적용`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  }
}
