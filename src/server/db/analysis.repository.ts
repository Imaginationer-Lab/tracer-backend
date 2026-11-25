import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Analysis, ApiError, ProviderDetail, ProviderId, RepoRef } from '../../api/contract.js';
import type { AmbiguousItem } from '../../engine/types.js';
import { validateRule, type Rule } from '../../engine/rules.js';
import type { EndpointUse, WorkerOutput } from '../../engine/worker.js';
import { DB_POOL } from './database.module.js';

export interface AnalysisRecord extends Analysis {
  rulesetVersion: string;
  details: Partial<Record<ProviderId, ProviderDetail>> | null;
  ambiguous: AmbiguousItem[] | null;
}

interface AnalysisRow extends RowDataPacket {
  id: string;
  owner: string;
  repo: string;
  branch: string;
  commit_sha: string;
  ruleset_version: string;
  status: Analysis['status'];
  steps: Analysis['steps'];
  error: ApiError | null;
  result: Analysis['result'];
  details: AnalysisRecord['details'];
  ambiguous: AmbiguousItem[] | null;
}

const toRecord = (r: AnalysisRow): AnalysisRecord => ({
  id: r.id,
  status: r.status,
  repo: { owner: r.owner, name: r.repo, branch: r.branch, commit: r.commit_sha },
  steps: r.steps,
  error: r.error,
  result: r.result,
  rulesetVersion: r.ruleset_version,
  details: r.details,
  ambiguous: r.ambiguous,
});

const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

@Injectable()
export class AnalysisRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async findById(id: string): Promise<AnalysisRecord | null> {
    const [rows] = await this.pool.execute<AnalysisRow[]>('SELECT * FROM analyses WHERE id = ?', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByCommit(repo: RepoRef, rulesetVersion: string): Promise<AnalysisRecord | null> {
    const [rows] = await this.pool.execute<AnalysisRow[]>(
      'SELECT * FROM analyses WHERE owner = ? AND repo = ? AND commit_sha = ? AND ruleset_version = ?',
      [repo.owner, repo.name, repo.commit, rulesetVersion],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** 같은 커밋의 실패한 분석이 있으면 지우고 새로 만든다. 동시에 같은 커밋을 만들면 false */
  async insertRunning(id: string, repo: RepoRef, rulesetVersion: string, steps: Analysis['steps']): Promise<boolean> {
    await this.pool.execute(
      `DELETE FROM analyses WHERE owner = ? AND repo = ? AND commit_sha = ? AND ruleset_version = ? AND status = 'failed'`,
      [repo.owner, repo.name, repo.commit, rulesetVersion],
    );
    try {
      await this.pool.execute(
        `INSERT INTO analyses (id, owner, repo, branch, commit_sha, ruleset_version, status, steps) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
        [id, repo.owner, repo.name, repo.branch, repo.commit, rulesetVersion, json(steps)],
      );
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY') return false;
      throw err;
    }
  }

  async updateSteps(id: string, steps: Analysis['steps']): Promise<void> {
    await this.pool.execute('UPDATE analyses SET steps = ? WHERE id = ?', [json(steps), id]);
  }

  async markDone(id: string, steps: Analysis['steps'], out: WorkerOutput): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(`UPDATE analyses SET status = 'done', steps = ?, result = ?, details = ?, ambiguous = ?, stats = ? WHERE id = ?`, [
        json(steps),
        json(out.result),
        json(out.details),
        json(out.ambiguous),
        json(out.stats),
        id,
      ]);
      for (const e of out.endpoints) {
        const endpointId = await this.upsertEndpoint(conn, e);
        for (const o of e.occurrences) {
          await conn.execute('INSERT IGNORE INTO analysis_endpoints (analysis_id, endpoint_id, file_path, line) VALUES (?, ?, ?, ?)', [
            id,
            endpointId,
            o.path,
            o.line,
          ]);
        }
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async markFailed(id: string, steps: Analysis['steps'], error: ApiError): Promise<void> {
    await this.pool.execute(`UPDATE analyses SET status = 'failed', steps = ?, error = ? WHERE id = ?`, [json(steps), json(error), id]);
  }

  /** 서버가 분석 도중 꺼졌으면 그 분석은 다시 돌리지 않고 실패로 둔다 (같은 저장소가 서버를 반복해서 죽이는 것 방지) */
  async failInterrupted(error: ApiError): Promise<number> {
    const [res] = await this.pool.execute<ResultSetHeader>(`UPDATE analyses SET status = 'failed', error = ? WHERE status = 'running'`, [json(error)]);
    return res.affectedRows;
  }

  async loadLearnedRules(): Promise<Rule[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT rule FROM learned_rules ORDER BY id');
    return rows.flatMap((r) => {
      const v = validateRule(r.rule);
      return v.ok ? [v.rule] : [];
    });
  }

  private async upsertEndpoint(conn: Pick<Pool, 'execute'>, e: EndpointUse): Promise<number> {
    const key = createHash('sha1').update(`${e.provider}|${e.host}|${e.path}`).digest('hex');
    // id = LAST_INSERT_ID(id): 이미 있으면 기존 id를 돌려받는다
    const [res] = await conn.execute<ResultSetHeader>(
      'INSERT INTO endpoints (endpoint_key, provider, host, path) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
      [key, e.provider, e.host, e.path.slice(0, 512)],
    );
    return res.insertId;
  }
}
