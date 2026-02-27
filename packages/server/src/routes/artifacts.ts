import { Hono } from 'hono';

/**
 * Artifact routes — serve canvas artifacts rendered by the agent.
 * The getArtifact / listArtifacts / getArtifactVersion functions are injected from @joule/tools.
 */
export function artifactsRoutes(
  getArtifact: (id: string) => { id: string; title: string; html: string; version: number; tags: string[]; createdAt: string; updatedAt: string } | undefined,
  listArtifacts: (limit?: number, offset?: number) => { artifacts: Array<{ id: string; title: string; version: number; tags: string[]; createdAt: string; updatedAt: string }>; total: number },
  getArtifactVersion: (id: string, version: number) => { id: string; title: string; html: string; version: number; createdAt: string; updatedAt: string } | undefined,
) {
  const router = new Hono();

  // List canvas artifacts (paginated, metadata only)
  router.get('/', (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
    const offset = Math.max(parseInt(c.req.query('offset') || '0', 10), 0);
    const { artifacts, total } = listArtifacts(limit, offset);

    return c.json({
      artifacts: artifacts.map(a => ({
        id: a.id,
        title: a.title,
        version: a.version,
        tags: a.tags,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
      total,
      limit,
      offset,
    });
  });

  // Get a single artifact's full HTML
  router.get('/:id', (c) => {
    const artifact = getArtifact(c.req.param('id'));
    if (!artifact) {
      return c.json({ error: 'Artifact not found' }, 404);
    }
    c.header('Cache-Control', 'public, max-age=60');
    return c.html(artifact.html);
  });

  // Get artifact metadata as JSON
  router.get('/:id/meta', (c) => {
    const artifact = getArtifact(c.req.param('id'));
    if (!artifact) {
      return c.json({ error: 'Artifact not found' }, 404);
    }
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({
      id: artifact.id,
      title: artifact.title,
      version: artifact.version,
      tags: artifact.tags,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    });
  });

  // Get a specific version of an artifact
  router.get('/:id/versions/:version', (c) => {
    const version = parseInt(c.req.param('version'), 10);
    if (isNaN(version) || version < 0) {
      return c.json({ error: 'Invalid version number' }, 400);
    }
    const artifact = getArtifactVersion(c.req.param('id'), version);
    if (!artifact) {
      return c.json({ error: 'Version not found' }, 404);
    }
    c.header('Cache-Control', 'public, max-age=3600');
    return c.html(artifact.html);
  });

  return router;
}
