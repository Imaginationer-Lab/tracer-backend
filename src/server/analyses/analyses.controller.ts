import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Analysis, ProviderDetail } from '../../api/contract.js';
import { AnalysesService } from './analyses.service.js';

@Controller('analyses')
export class AnalysesController {
  constructor(private readonly analyses: AnalysesService) {}

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
}
