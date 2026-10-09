import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import * as argon2 from 'argon2';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { Channel } from '../channels/entities/channel.entity';
import { DomainExceptionFilter } from '../common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../common/filters/validation-exception.filter';
import { User } from '../users/entities/user.entity';

export interface E2eContext {
  app: INestApplication<App>;
  dataSource: DataSource;
  resetThrottling: () => void;
}

export interface AuthenticatedUser {
  user: User;
  channel: Channel;
  accessToken: string;
}

const E2E_PASSWORD = 'password123';

export async function createE2eApp(): Promise<E2eContext> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  const throttlerStorage =
    moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);

  return {
    app,
    dataSource: moduleFixture.get(DataSource),
    resetThrottling: () => throttlerStorage.storage.clear(),
  };
}

let userCounter = 0;

export async function createAuthenticatedUser(
  { app, dataSource }: E2eContext,
  label = 'e2e',
): Promise<AuthenticatedUser> {
  const index = ++userCounter;
  const email = `${label}_${index}_${Date.now()}@example.com`;
  const userRepository = dataSource.getRepository(User);
  const channelRepository = dataSource.getRepository(Channel);

  const user = await userRepository.save(
    userRepository.create({
      email,
      password: await argon2.hash(E2E_PASSWORD),
      is_confirmed: true,
    }),
  );
  const channel = await channelRepository.save(
    channelRepository.create({
      name: `${label} ${index}`,
      nickname: `${label}-${index}-${Date.now()}`,
      user_id: user.id,
    }),
  );

  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: E2E_PASSWORD })
    .expect(200);

  return {
    user,
    channel,
    accessToken: (res.body as { access_token: string }).access_token,
  };
}
