/**
 * StationRegistry — holds all registered stations, looked up by id or label.
 *
 * Usage:
 *   const registry = StationRegistry.createDefault(config);
 *   const station = registry.get('spec');
 *   const allStations = registry.getAll();
 *
 * To add a new station:
 *   1. Create src/stations/<name>/index.ts implementing BaseStation
 *   2. Import it in createDefault() below
 *   3. Call registry.register(new YourStation())
 *   4. Add the station to pipelines.json
 */

import type { Config } from '../types/index.js';
import { BaseStation } from './base.js';

export class StationRegistry {
  private stations: Map<string, BaseStation> = new Map();
  private byLabel: Map<string, BaseStation> = new Map();

  /**
   * Register a station.
   * Throws if a station with the same id is already registered.
   */
  register(station: BaseStation): void {
    if (this.stations.has(station.id)) {
      throw new Error(`Station "${station.id}" is already registered`);
    }
    this.stations.set(station.id, station);
    this.byLabel.set(station.label, station);
  }

  /**
   * Look up a station by its unique id.
   * e.g. 'spec', 'design', 'research'
   */
  get(id: string): BaseStation | undefined {
    return this.stations.get(id);
  }

  /**
   * Look up a station by its triggering GitHub label.
   * e.g. 'station:intake' → SpecStation
   *      'pipeline:content' → ResearchStation
   */
  getByLabel(label: string): BaseStation | undefined {
    return this.byLabel.get(label);
  }

  /**
   * Return all stations in registration order.
   */
  getAll(): BaseStation[] {
    return Array.from(this.stations.values());
  }

  /**
   * List all registered station IDs.
   */
  list(): string[] {
    return Array.from(this.stations.keys());
  }

  /**
   * Create and register all built-in stations.
   * Called once at startup.
   *
   * ─── Software Pipeline ────────────────────────────────────
   * spec     → intake → spec
   * design   → spec   → design
   * build    → design → build
   * qa       → build  → qa
   * bugfix   → bugfix → build
   *
   * ─── Content Pipeline ─────────────────────────────────────
   * research → pipeline:content → station:draft
   * draft    → station:draft    → station:review
   * review   → station:review   → station:publish
   * publish  → station:publish  → station:done
   */
  static createDefault(_config: Config): StationRegistry {
    // Lazy-import to avoid circular deps — stations import from base/registry
    // but registry doesn't import station implementations at module load time.
    const { SpecStation } = require('./spec/index.js') as { SpecStation: new () => BaseStation };
    const { DesignStation } = require('./design/index.js') as { DesignStation: new () => BaseStation };
    const { BuildStation } = require('./build/index.js') as { BuildStation: new () => BaseStation };
    const { QAStation } = require('./qa/index.js') as { QAStation: new () => BaseStation };
    const { BugfixStation } = require('./bugfix/index.js') as { BugfixStation: new () => BaseStation };

    // Content pipeline stations
    const { ResearchStation } = require('./research/index.js') as { ResearchStation: new () => BaseStation };
    const { DraftStation } = require('./draft/index.js') as { DraftStation: new () => BaseStation };
    const { ReviewStation } = require('./review/index.js') as { ReviewStation: new () => BaseStation };
    const { PublishStation } = require('./publish/index.js') as { PublishStation: new () => BaseStation };

    const registry = new StationRegistry();

    // ── Software pipeline ──
    registry.register(new SpecStation());
    registry.register(new DesignStation());
    registry.register(new BuildStation());
    registry.register(new QAStation());
    registry.register(new BugfixStation());

    // ── Content pipeline ──
    registry.register(new ResearchStation());
    registry.register(new DraftStation());
    registry.register(new ReviewStation());
    registry.register(new PublishStation());

    return registry;
  }
}
