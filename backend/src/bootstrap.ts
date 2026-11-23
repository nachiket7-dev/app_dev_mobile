import { ConsoleLogger, NestApplicationOptions, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { JSON_BODY_LIMIT } from './common/base64.util';
import { CONFIG } from './common/config';
import { requestBounds, RequestLifetimeInterceptor, SafeExceptionFilter } from './common/http-security';

export async function createApplication(options: NestApplicationOptions = {}) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    ...options, logger: options.logger ?? new ConsoleLogger({ colors: false }), bodyParser: false, abortOnError: false,
  });
  app.set('trust proxy', CONFIG.trustProxyHops);
  app.disable('x-powered-by');
  app.enableCors({
    origin: (origin, callback) => callback(null, !origin || CONFIG.corsOrigins.includes(origin)),
    methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type'],
    exposedHeaders: ['Content-Type', 'Content-Length'], credentials: false, maxAge: 600,
  });
  app.use(requestBounds());
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useBodyParser('urlencoded', { extended: true, limit: JSON_BODY_LIMIT, parameterLimit: 128, depth: 4 });
  app.useGlobalPipes(new ValidationPipe({
    transform: true, whitelist: true, forbidNonWhitelisted: true,
    validationError: { target: false, value: false },
  }));
  app.useGlobalFilters(new SafeExceptionFilter());
  app.useGlobalInterceptors(new RequestLifetimeInterceptor());
  const config = new DocumentBuilder()
    .setTitle('Chat App API').setVersion('1.1.0')
    .setDescription(
      'Included backend: private conversations, stable history, retry-safe sends and caller-only receipts. ' +
      'GET /health is public. Protected routes use the course raw header `Authorization: Basic username:password`, ' +
      'NOT base64-encoded HTTP Basic. First use registers an ordinary human account. HTTPS is required outside explicit local tests.',
    )
    .addApiKey({ type: 'apiKey', in: 'header', name: 'Authorization',
      description: 'Enter the entire raw header value: Basic username:password (not base64)' }, 'basic-auth')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  const server = app.getHttpServer();
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.timeout = 60_000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = CONFIG.maxConcurrentRequests * 2;
  app.enableShutdownHooks();
  return app;
}
