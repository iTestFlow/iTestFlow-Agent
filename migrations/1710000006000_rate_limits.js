/* eslint-disable camelcase */

/**
 * Follow-up (d) — cross-replica rate limiting.
 *
 * A shared fixed-window counter so multiple web replicas enforce one global limit
 * (the in-memory limiter counts per-process). Keys are pre-auth and IP-based
 * (e.g. "login:<ip>"), so the table is global, not workspace-scoped. The key is
 * the primary key and each row is overwritten in place every window, so the table
 * never grows past the number of distinct keys. reset_at_ms is a ms epoch (bigint);
 * other timestamps stay ISO text, consistent with the rest of the schema.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE rate_limits (
      key text PRIMARY KEY,
      reset_at_ms bigint NOT NULL,
      count integer NOT NULL,
      updated_at text NOT NULL
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS rate_limits CASCADE;`);
};
