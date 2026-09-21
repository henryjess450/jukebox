/**
 * Content-hashed URLs for static files.
 *
 * Static assets are cached hard (an hour), which is right for a phone on
 * venue Wi-Fi — but it also meant a rebuilt stylesheet or script was ignored
 * by every browser that had already loaded the old one, for an hour, with no
 * way to force it. A returning guest could get new HTML and stale JavaScript,
 * which is worse than either.
 *
 * Hashing the contents into the URL makes a changed file a different URL, so
 * caches update immediately and unchanged files stay cached.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log.js';

const versions = new Map<string, string>();

/** Read each file once at boot and remember a short hash of its contents. */
export function loadAssetVersions(publicDir: string, files: string[]): void {
  for (const file of files) {
    try {
      const hash = createHash('sha1').update(readFileSync(join(publicDir, file))).digest('hex');
      versions.set(file, hash.slice(0, 10));
    } catch (err) {
      // A missing asset is a build problem, not a reason to refuse to serve.
      log.warn('could not hash static asset', { file, err });
    }
  }
}

/** `/static/app.css` → `/static/app.css?v=1a2b3c4d5e` */
export function asset(file: string): string {
  const version = versions.get(file);
  return version ? `/static/${file}?v=${version}` : `/static/${file}`;
}
