import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ApiExceptionFilter } from './api-exception.filter.js';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';

const cfg = loadConfig();
// 숫자면 "앞단 프록시 홉 수": 그만큼만 X-Forwarded-For를 믿는다
const hops = cfg.trustProxy;
const trustProxy = typeof hops === 'number' ? (_addr: string, hop: number) => hop < hops : hops;
const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy, bodyLimit: 16 * 1024 }));
app.setGlobalPrefix('api');
app.useGlobalFilters(new ApiExceptionFilter());
app.enableShutdownHooks();
await app.listen(cfg.port, '0.0.0.0');
