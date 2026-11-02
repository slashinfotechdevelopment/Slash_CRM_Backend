import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Security headers with Helmet
  app.use(helmet());

  // CORS configuration
  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  });

  // Global routing prefix (configured as /api without /v1 per preference)
  app.setGlobalPrefix('api');

  // Global input validation according to CRM architecture specification
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Centralized response format and exception handling
  app.useGlobalInterceptors(new TransformInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());

  // Swagger API Documentation setup
  const config = new DocumentBuilder()
    .setTitle('Slash Infotech CRM API')
    .setDescription(
      'Enterprise Production CRM Backend — OTP Authentication, RBAC, Lead & Project Management',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'Authorization',
        description: 'Enter your Bearer access token',
        in: 'header',
      },
      'JWT-auth',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  const port = Number(process.env.PORT || 5000);
  const host = process.env.HOST || '0.0.0.0';

  // Listen on 0.0.0.0 to allow access from localhost (127.0.0.1) and LAN IP address
  await app.listen(port, host);

  logger.log(`Slash Infotech CRM backend running on port ${port}`);
  logger.log(`Local API:        http://localhost:${port}/api`);
  logger.log(`Network API:      http://${host === '0.0.0.0' ? '<YOUR-LAN-IP>' : host}:${port}/api`);
  logger.log(`Swagger Docs:     http://localhost:${port}/api/docs`);
}

bootstrap();
