import { Global, Inject, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { MIGRATIONS } from './migrations.js';

export const DB_POOL = Symbol('DB_POOL');

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig): Pool =>
        // mysql2는 JSON 컬럼을 객체로 돌려준다
        createPool({ uri: cfg.databaseUrl, connectionLimit: 10, timezone: 'Z' }),
    },
  ],
  exports: [DB_POOL],
})
export class DatabaseModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Database');

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

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
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (id VARCHAR(100) NOT NULL PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`,
    );
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT id FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.id as string));
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      // MySQL DDL은 트랜잭션으로 묶이지 않아서, 실패하면 남은 문장부터 손으로 이어가야 한다
      for (const sql of m.sql) await this.pool.query(sql);
      await this.pool.query('INSERT INTO schema_migrations (id) VALUES (?)', [m.id]);
      this.logger.log(`migration ${m.id} 적용`);
    }
  }
}
