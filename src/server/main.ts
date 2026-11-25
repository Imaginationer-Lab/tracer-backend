import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ApiExceptionFilter } from './api-exception.filter.js';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { applyCors } from './cors.js';
import { trustProxyOption } from './proxy.js';

const cfg = loadConfig();
const app = await NestFactory.create<NestFastifyApplication>(
  AppModule,
  new FastifyAdapter({ trustProxy: trustProxyOption(cfg.trustProxy), bodyLimit: 16 * 1024 }),
);
app.setGlobalPrefix('api');
applyCors(app, cfg.corsOrigins);
app.useGlobalFilters(new ApiExceptionFilter());
app.enableShutdownHooks();
await app.listen(cfg.port, '0.0.0.0');
