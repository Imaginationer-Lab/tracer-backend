import { Module } from '@nestjs/common';
import { AnalysesController } from './analyses/analyses.controller.js';
import { AnalysesService } from './analyses/analyses.service.js';
import { EnginePool } from './analyses/engine-pool.js';
import { RateLimiter } from './analyses/rate-limiter.js';
import { ConfigModule } from './config.module.js';
import { AnalysisRepository } from './db/analysis.repository.js';
import { DatabaseModule } from './db/database.module.js';
import { DemoController } from './demo/demo.controller.js';
import { GitHubClient } from './github/github.client.js';
import { RepoLoader } from './github/repo-loader.js';
import { HealthController } from './health.controller.js';
import { ClueClassifier } from './llm/clue-classifier.js';
import { ProvidersController } from './providers/providers.controller.js';
import { AlternativesService } from './alternatives/alternatives.service.js';
import { HostProber } from './providers/host-probe.js';
import { StatusRegistry } from './providers/status-registry.js';
import { StatusService } from './providers/status.service.js';

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [AnalysesController, ProvidersController, DemoController, HealthController],
  providers: [AlternativesService, AnalysisRepository, AnalysesService, ClueClassifier, EnginePool, GitHubClient, HostProber, RateLimiter, RepoLoader, StatusRegistry, StatusService],
})
export class AppModule {}
