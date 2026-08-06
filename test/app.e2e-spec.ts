import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '@/app.module';
import { createValidationPipe } from '@/common/pipes/validation.pipe';

describe('Electrosync API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves a health greeting at the root', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Electrosync backend is running.');
  });

  /**
   * These assert that a malformed customer number is rejected at the edge. That
   * matters beyond input hygiene: a request that gets past validation costs a
   * multi-second scrape of a third-party site, so rejecting early is the
   * difference between a 1ms 400 and a wasted upstream round trip.
   */
  describe.each(['balance', 'info', 'recharges', 'consumption'])(
    'GET /nesco/:customerNo/%s',
    (route) => {
      it('rejects a non-numeric customer number without calling upstream', () => {
        return request(app.getHttpServer())
          .get(`/nesco/not-a-number/${route}`)
          .expect(400);
      });

      it('rejects a too-short customer number', () => {
        return request(app.getHttpServer())
          .get(`/nesco/123/${route}`)
          .expect(400);
      });

      it('stays public, since these were open before auth existed', () => {
        // A 400 proves the request reached validation rather than being turned
        // away by the global guard, which would answer 401.
        return request(app.getHttpServer())
          .get(`/nesco/abc/${route}`)
          .expect(400);
      });
    },
  );

  /**
   * The global guard denies by default, so these assert the boundary directly:
   * every notification route must be unreachable without a bearer token. Before
   * auth existed each of them accepted a caller-supplied `userId`, which let
   * anyone read or modify anyone's notifications.
   */
  describe('protected routes reject anonymous callers', () => {
    it.each([
      ['GET', '/notifications'],
      ['PATCH', '/notifications/some-id/read'],
      ['POST', '/notifications/tokens'],
      ['DELETE', '/notifications/tokens/some-token'],
      ['GET', '/auth/me'],
    ])('%s %s → 401', (method, path) => {
      const call = method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete';
      return request(app.getHttpServer())[call](path).expect(401);
    });

    it.each([
      ['a non-bearer scheme', 'Basic dXNlcjpwYXNz'],
      ['a forged token', 'Bearer not.a.real.token'],
    ])('rejects %s', (_label, authorization) => {
      return request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', authorization)
        .expect(401);
    });
  });

  describe('auth routes are public but validated', () => {
    it.each([
      ['/auth/register', {}],
      ['/auth/login', { email: 'not-an-email', password: 'x' }],
      ['/auth/refresh', {}],
    ])('POST %s rejects a malformed body with 400', (path, body) => {
      // 400 rather than 401 confirms the route is @Public() and the failure is
      // validation, not the guard.
      return request(app.getHttpServer()).post(path).send(body).expect(400);
    });
  });
});
