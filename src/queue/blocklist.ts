/** Blocked tracks and artists. Small enough to keep entirely in memory, and
 *  read on every request, so it is cached and refreshed on write. */
import type { Db } from '../db/index.js';
import { now } from '../db/index.js';

export interface BlocklistEntry {
  id: number;
  kind: 'track' | 'artist';
  spotify_id: string;
  label: string;
  created_at: string;
}

export class BlocklistRepository {
  readonly #db: Db;
  #trackIds = new Set<string>();
  #artistIds = new Set<string>();

  constructor(db: Db) {
    this.#db = db;
    this.refresh();
  }

  refresh(): void {
    const rows = this.#db.prepare('SELECT kind, spotify_id FROM blocklist').all() as Array<{
      kind: string;
      spotify_id: string;
    }>;
    this.#trackIds = new Set(rows.filter((r) => r.kind === 'track').map((r) => r.spotify_id));
    this.#artistIds = new Set(rows.filter((r) => r.kind === 'artist').map((r) => r.spotify_id));
  }

  get trackIds(): ReadonlySet<string> {
    return this.#trackIds;
  }

  get artistIds(): ReadonlySet<string> {
    return this.#artistIds;
  }

  add(kind: 'track' | 'artist', spotifyId: string, label: string): void {
    this.#db
      .prepare(
        `INSERT INTO blocklist (kind, spotify_id, label, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (kind, spotify_id) DO UPDATE SET label = excluded.label`,
      )
      .run(kind, spotifyId, label, now());
    this.refresh();
  }

  remove(id: number): void {
    this.#db.prepare('DELETE FROM blocklist WHERE id = ?').run(id);
    this.refresh();
  }

  list(): BlocklistEntry[] {
    return this.#db
      .prepare('SELECT * FROM blocklist ORDER BY kind, label')
      .all() as BlocklistEntry[];
  }
}
