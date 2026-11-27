import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import type { Analysis, ApiError, ProviderId, RepoRef } from '../../api/contract.js';
import type { StoredDetail } from '../../api/present.js';
import type { AmbiguousItem } from '../../engine/types.js';
import type { Verdict } from '../../engine/learn.js';
import type { StatusSource } from '../providers/status-sources.js';
import type { AltPlan } from '../alternatives/alternatives.js';
import type { EndpointUse, WorkerOutput } from '../../engine/worker.js';
import { DB_POOL } from './database.module.js';

export interface AnalysisRecord extends Analysis {
  rulesetVersion: string;
  details: Partial<Record<ProviderId, StoredDetail>> | null;
  ambiguous: AmbiguousItem[] | null;
}

interface AnalysisRow {
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

/**
 * pg는 JS 배열을 Postgres 배열로 바꿔서 보내므로, jsonb에 넣을 값은 직접 JSON 문자열로 만들고 SQL에서 ::jsonb로 받는다.
 */
const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

@Injectable()
export class AnalysisRepository {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  async findById(id: string): Promise<AnalysisRecord | null> {
    const { rows } = await this.pool.query<AnalysisRow>('SELECT * FROM analyses WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByCommit(repo: RepoRef, rulesetVersion: string): Promise<AnalysisRecord | null> {
    const { rows } = await this.pool.query<AnalysisRow>(
      'SELECT * FROM analyses WHERE owner = $1 AND repo = $2 AND commit_sha = $3 AND ruleset_version = $4',
      [repo.owner, repo.name, repo.commit, rulesetVersion],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** 같은 커밋의 실패한 분석이 있으면 지우고 새로 만든다. 다른 요청이 같은 커밋을 먼저 만들었으면 false */
  async insertRunning(id: string, repo: RepoRef, rulesetVersion: string, steps: Analysis['steps']): Promise<boolean> {
    await this.pool.query(`DELETE FROM analyses WHERE owner = $1 AND repo = $2 AND commit_sha = $3 AND ruleset_version = $4 AND status = 'failed'`, [
      repo.owner,
      repo.name,
      repo.commit,
      rulesetVersion,
    ]);
    // ON CONFLICT DO NOTHING: 유니크 충돌이면 오류 대신 0행
    const { rowCount } = await this.pool.query(
      `INSERT INTO analyses (id, owner, repo, branch, commit_sha, ruleset_version, status, steps)
       VALUES ($1, $2, $3, $4, $5, $6, 'running', $7::jsonb)
       ON CONFLICT ON CONSTRAINT uq_analyses_commit DO NOTHING`,
      [id, repo.owner, repo.name, repo.branch, repo.commit, rulesetVersion, json(steps)],
    );
    return rowCount === 1;
  }

  async updateSteps(id: string, steps: Analysis['steps']): Promise<void> {
    // Postgres에는 MySQL의 ON UPDATE CURRENT_TIMESTAMP가 없어서 updated_at을 직접 바꾼다
    await this.pool.query('UPDATE analyses SET steps = $1::jsonb, updated_at = now() WHERE id = $2', [json(steps), id]);
  }

  async markDone(id: string, steps: Analysis['steps'], out: WorkerOutput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE analyses
         SET status = 'done', steps = $1::jsonb, result = $2::jsonb, details = $3::jsonb, ambiguous = $4::jsonb, stats = $5::jsonb, updated_at = now()
         WHERE id = $6`,
        [json(steps), json(out.result), json(out.details), json(out.ambiguous), json(out.stats), id],
      );
      for (const e of out.endpoints) {
        const endpointId = await this.upsertEndpoint(client, e);
        for (const o of e.occurrences) {
          await client.query(
            'INSERT INTO analysis_endpoints (analysis_id, endpoint_id, file_path, line) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
            [id, endpointId, o.path, o.line],
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async markFailed(id: string, steps: Analysis['steps'], error: ApiError): Promise<void> {
    await this.pool.query(`UPDATE analyses SET status = 'failed', steps = $1::jsonb, error = $2::jsonb, updated_at = now() WHERE id = $3`, [
      json(steps),
      json(error),
      id,
    ]);
  }

  /** 서버가 분석 도중 꺼졌으면 그 분석은 다시 돌리지 않고 실패로 둔다 (같은 저장소가 서버를 반복해서 죽이는 것 방지) */
  async failInterrupted(error: ApiError): Promise<number> {
    const { rowCount } = await this.pool.query(`UPDATE analyses SET status = 'failed', error = $1::jsonb, updated_at = now() WHERE status = 'running'`, [
      json(error),
    ]);
    return rowCount ?? 0;
  }

  /** 단서 키로 저장된 AI 판정. 찾은 단서는 hits를 올린다 */
  async findJudgments(keys: string[]): Promise<Map<string, Verdict>> {
    if (!keys.length) return new Map();
    const { rows } = await this.pool.query<{ clue_key: string; judgment: Verdict }>(
      `UPDATE clue_classifications SET hits = hits + 1 WHERE clue_key = ANY($1::text[]) AND judgment IS NOT NULL RETURNING clue_key, judgment`,
      [keys],
    );
    return new Map(rows.map((r) => [r.clue_key, r.judgment]));
  }

  async saveJudgments(rows: { key: string; kind: AmbiguousItem['kind']; verdict: Verdict; model: string }[]): Promise<void> {
    if (!rows.length) return;
    const provider = (v: Verdict) => (v.verdict === 'service' ? v.service.id : v.verdict);
    const service = (v: Verdict) => (v.verdict === 'service' ? v.service.name : null);
    await this.pool.query(
      `INSERT INTO clue_classifications (clue_key, kind, provider, service, model, judgment, hits)
       SELECT k, kind, provider, service, model, judgment::jsonb, 1
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS t(k, kind, provider, service, model, judgment)
       ON CONFLICT (clue_key) DO NOTHING`,
      [
        rows.map((r) => r.key),
        rows.map((r) => r.kind),
        rows.map((r) => provider(r.verdict)),
        rows.map((r) => service(r.verdict)),
        rows.map((r) => r.model),
        rows.map((r) => JSON.stringify(r.verdict)),
      ],
    );
  }

  async loadStatusSources(): Promise<{ id: string; source: StatusSource | null; checkedAt: number }[]> {
    const { rows } = await this.pool.query<{ service_id: string; page_url: string | null; api_url: string | null; state: string; checked_at: Date }>(
      'SELECT service_id, page_url, api_url, state, checked_at FROM status_sources',
    );
    return rows.map((r) => ({
      id: r.service_id,
      source: r.state === 'verified' && r.page_url && r.api_url ? { pageUrl: r.page_url, apiUrl: r.api_url } : null,
      checkedAt: r.checked_at.getTime(),
    }));
  }

  async findAlternatives(key: string): Promise<{ plan: AltPlan; createdAt: Date } | null> {
    const { rows } = await this.pool.query<{ plan: AltPlan; created_at: Date }>('SELECT plan, created_at FROM alternatives WHERE key = $1', [key]);
    return rows[0] ? { plan: rows[0].plan, createdAt: rows[0].created_at } : null;
  }

  async saveAlternatives(key: string, serviceId: string, plan: AltPlan): Promise<Date> {
    const { rows } = await this.pool.query<{ created_at: Date }>(
      `INSERT INTO alternatives (key, service_id, plan) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (key) DO UPDATE SET plan = EXCLUDED.plan, created_at = now() RETURNING created_at`,
      [key, serviceId, JSON.stringify(plan)],
    );
    return rows[0]!.created_at;
  }

  async saveStatusSource(row: { id: string; name: string; source: StatusSource | null }): Promise<void> {
    await this.pool.query(
      `INSERT INTO status_sources (service_id, name, page_url, api_url, state, checked_at) VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (service_id) DO UPDATE SET name = EXCLUDED.name, page_url = EXCLUDED.page_url, api_url = EXCLUDED.api_url, state = EXCLUDED.state, checked_at = now()`,
      [row.id, row.name.slice(0, 100), row.source?.pageUrl ?? null, row.source?.apiUrl ?? null, row.source ? 'verified' : 'none'],
    );
  }

  /**
   * 있으면 기존 id, 없으면 새 id. DO NOTHING은 충돌 시 RETURNING이 비어서,
   * 아무것도 바꾸지 않는 DO UPDATE로 기존 행의 id를 돌려받는다.
   */
  private async upsertEndpoint(client: pg.PoolClient, e: EndpointUse): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO endpoints (provider, host, path) VALUES ($1, $2, $3)
       ON CONFLICT ON CONSTRAINT uq_endpoints DO UPDATE SET provider = EXCLUDED.provider
       RETURNING id`,
      [e.provider, e.host, e.path],
    );
    return rows[0]!.id;
  }
}
