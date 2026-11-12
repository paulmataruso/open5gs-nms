import Database from 'better-sqlite3';
import type { Request, Response, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { createRadioSignalRouter } from '../radio-signal-controller';
import type { ISubscriberRepository } from '../../../domain/interfaces/subscriber-repository';
import type { ActiveSessionsUseCase } from '../../../application/use-cases/active-sessions';

describe('UE Signal read access', () => {
  const db = new Database(':memory:', { nativeBinding: process.env.HA_SQLITE_TEST_BINDING });
  const router = createRadioSignalRouter(db, {} as ISubscriberRepository,
    {} as ActiveSessionsUseCase, {} as Logger);
  afterAll(() => db.close());

  it.each(['/radios', '/overview'])('%s blocks non-admin access before reading data', path => {
    const routes = router.stack as unknown as Array<{ route?: {
      path: string; methods: { get?: boolean }; stack: Array<{ handle: RequestHandler }>;
    } }>;
    const layer = routes.find(layer => layer.route?.path === path && layer.route.methods.get);
    if (!layer?.route) throw new Error(`GET ${path} was not registered`);
    const guard = layer.route.stack[0].handle;
    for (const role of [undefined, 'viewer']) {
      const next = jest.fn();
      const status = jest.fn().mockReturnThis();
      const json = jest.fn();
      guard({ user: role ? { role } : undefined } as Request,
        { status, json } as unknown as Response, next);
      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalledWith({ success: false, error: 'Forbidden: admin role required' });
      expect(next).not.toHaveBeenCalled();
    }
    const next = jest.fn();
    guard({ user: { role: 'admin' } } as Request, {} as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
