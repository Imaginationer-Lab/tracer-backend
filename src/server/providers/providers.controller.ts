import { Controller, Get, Param } from '@nestjs/common';
import type { ProviderStatus } from '../../api/contract.js';
import { StatusService } from './status.service.js';

@Controller('providers')
export class ProvidersController {
  constructor(private readonly status: StatusService) {}

  @Get(':providerId/status')
  get(@Param('providerId') providerId: string): Promise<ProviderStatus> {
    return this.status.get(providerId);
  }
}
