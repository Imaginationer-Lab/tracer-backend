import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Analysis, ProviderAlternatives, ProviderDetail } from '../../api/contract.js';
import { AlternativesService } from '../alternatives/alternatives.service.js';
import { AnalysesService } from './analyses.service.js';

@Controller('analyses')
export class AnalysesController {
  constructor(
    private readonly analyses: AnalysesService,
    private readonly alternatives: AlternativesService,
  ) {}

  /** 새 분석이면 202, 같은 커밋 결과가 이미 있으면 200 */
  @Post()
  async create(@Body() body: { repoUrl?: unknown } | undefined, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<Analysis> {
    const { analysis, created } = await this.analyses.create(body?.repoUrl, req.ip);
    void reply.status(created ? 202 : 200);
    return analysis;
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<Analysis> {
    return this.analyses.get(id);
  }

  @Get(':id/providers/:providerId')
  provider(@Param('id') id: string, @Param('providerId') providerId: string): Promise<ProviderDetail> {
    return this.analyses.providerDetail(id, providerId);
  }

  /** 대체 서비스 (AI 제안). 처음이면 몇 초 걸린다 */
  @Get(':id/providers/:providerId/alternatives')
  alternativesOf(@Param('id') id: string, @Param('providerId') providerId: string, @Req() req: FastifyRequest): Promise<ProviderAlternatives> {
    return this.alternatives.get(id, providerId, req.ip);
  }
}
