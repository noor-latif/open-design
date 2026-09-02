import fs from 'node:fs/promises';
import path from 'node:path';
import type { Express } from 'express';
import type { RouteDeps } from '../server-context.js';

export interface RegisterFsRoutesDeps extends RouteDeps<'paths'> {}

const ALLOWED_ROOTS = ['/var/home/noor', '/home/noor', '/tmp', '/app'];

function isInsideOrSame(relative: string): boolean {
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isAllowedPath(canonical: string): boolean {
  for (const root of ALLOWED_ROOTS) {
    const rel = path.relative(root, canonical);
    if (isInsideOrSame(rel)) return true;
  }
  return false;
}

function locationOverlapsDaemonData(locationPath: string, runtimeDirRaw: string): boolean {
  const runtimeDir = path.resolve(runtimeDirRaw);
  const projectsDir = path.join(runtimeDir, 'projects');
  const relativeToRuntime = path.relative(runtimeDir, locationPath);
  const runtimeInsideLocation = path.relative(locationPath, runtimeDir);
  const relativeToProjects = path.relative(projectsDir, locationPath);
  const projectsInsideLocation = path.relative(locationPath, projectsDir);
  return (
    isInsideOrSame(relativeToRuntime) ||
    isInsideOrSame(runtimeInsideLocation) ||
    isInsideOrSame(relativeToProjects) ||
    isInsideOrSame(projectsInsideLocation)
  );
}

export function registerFsRoutes(app: Express, ctx: RegisterFsRoutesDeps): void {
  const { RUNTIME_DATA_DIR, RUNTIME_DATA_DIR_CANONICAL } = ctx.paths;
  const runtimeDataDir = RUNTIME_DATA_DIR_CANONICAL || RUNTIME_DATA_DIR;

  app.get('/api/fs/list', async (req, res) => {
    try {
      const raw = typeof req.query.path === 'string' ? req.query.path : '';
      if (!raw || !raw.trim()) {
        return res.status(400).json({ error: 'path query param is required' });
      }
      const trimmed = raw.trim();
      if (!path.isAbsolute(trimmed)) {
        return res.status(400).json({ error: 'path must be absolute' });
      }
      const normalized = path.normalize(trimmed);
      let canonical: string;
      try {
        canonical = await fs.realpath(normalized);
      } catch {
        return res.status(400).json({ error: 'path does not exist' });
      }
      // Re-normalize after realpath (realpath already canonicalizes)
      canonical = path.normalize(canonical);
      if (!isAllowedPath(canonical)) {
        return res.status(400).json({ error: 'path not allowed' });
      }
      if (locationOverlapsDaemonData(canonical, runtimeDataDir)) {
        return res.status(400).json({ error: 'path overlaps daemon data' });
      }
      let stat: import('node:fs').Stats;
      try {
        stat = await fs.stat(canonical);
      } catch {
        return res.status(400).json({ error: 'path does not exist' });
      }
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'path is not a directory' });
      }
      const dirents = await fs.readdir(canonical, { withFileTypes: true });
      const entries = dirents.map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
        isFile: d.isFile(),
      }));
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
      const parent = canonical === path.dirname(canonical) ? null : path.dirname(canonical);
      res.json({ path: canonical, parent, entries });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });
}
