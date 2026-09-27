const path = require('path');
const { DuckDBInstance } = require('@duckdb/node-api');

const DATA = path.resolve(__dirname, '../../data');
const PARQUET = path.join(DATA, 'processed', 'los_points.parquet').replace(/\\/g, '/');

/**
 * Small DuckDB connection pool. The newest request is served first (LIFO), the same policy as the
 * Geoparaquate tile service: when the user clicks through points quickly, stale lookups wait.
 */
class DuckPool {
  constructor(size = parseInt(process.env.DB_WORKERS, 10) || 4) {
    this.size = size;
    this.idle = [];
    this.queue = [];
  }

  async init() {
    this.instance = await DuckDBInstance.create(':memory:', { threads: String(process.env.DB_THREADS || 8) });
    for (let i = 0; i < this.size; i++) {
      const conn = await this.instance.connect();
      await conn.run('INSTALL spatial; LOAD spatial;');
      if (i === 0) {
        await conn.run(`CREATE VIEW IF NOT EXISTS los AS SELECT * FROM read_parquet('${PARQUET}')`);
      }
      this.idle.push(conn);
    }
  }

  async query(sql, params = []) {
    const conn = this.idle.pop() || (await new Promise((resolve) => this.queue.push(resolve)));
    try {
      const reader = await conn.runAndReadAll(sql, params);
      return reader.getRowObjectsJson();
    } finally {
      const next = this.queue.pop();
      if (next) next(conn);
      else this.idle.push(conn);
    }
  }
}

module.exports = { DuckPool, DATA, PARQUET };
