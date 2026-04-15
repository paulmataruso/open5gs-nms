import { Router, Request, Response } from 'express';
import pino from 'pino';
import { DockerLogStreamingUseCase } from '../../application/use-cases/docker-log-streaming';

export function createDockerRouter(
  dockerLogStreamingUseCase: DockerLogStreamingUseCase,
  logger: pino.Logger,
): Router {
  const router = Router();

  /**
   * GET /api/docker/containers
   * List all NMS containers
   */
  router.get('/containers', async (_req: Request, res: Response) => {
    try {
      const containers = await dockerLogStreamingUseCase.getContainers();

      res.json({
        success: true,
        containers,
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to list containers');
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve container list',
      });
    }
  });

  /**
   * GET /api/docker/logs/:container
   * Get recent logs from a specific container
   */
  router.get('/logs/:container', async (req: Request, res: Response) => {
    try {
      const { container } = req.params;
      const limit = parseInt(req.query.limit as string) || 100;

      const logs = await dockerLogStreamingUseCase.getRecentLogs([container], limit);

      res.json({
        success: true,
        logs,
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to retrieve container logs');
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve container logs',
      });
    }
  });

  return router;
}
