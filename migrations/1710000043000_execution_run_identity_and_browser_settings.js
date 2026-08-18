/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE playwright_execution_runs
      ADD COLUMN name text,
      ADD COLUMN headless boolean NOT NULL DEFAULT true,
      ADD COLUMN viewport_width integer NOT NULL DEFAULT 1920
        CHECK (viewport_width BETWEEN 320 AND 3840),
      ADD COLUMN viewport_height integer NOT NULL DEFAULT 1080
        CHECK (viewport_height BETWEEN 240 AND 2160);

    -- Profiles mirror the run setup (minus per-run identity like name), so a
    -- saved profile restores the browser window mode and size on apply.
    ALTER TABLE playwright_execution_profiles
      ADD COLUMN headless boolean NOT NULL DEFAULT true,
      ADD COLUMN viewport_width integer NOT NULL DEFAULT 1920
        CHECK (viewport_width BETWEEN 320 AND 3840),
      ADD COLUMN viewport_height integer NOT NULL DEFAULT 1080
        CHECK (viewport_height BETWEEN 240 AND 2160);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE playwright_execution_runs
      DROP COLUMN IF EXISTS name,
      DROP COLUMN IF EXISTS headless,
      DROP COLUMN IF EXISTS viewport_width,
      DROP COLUMN IF EXISTS viewport_height;

    ALTER TABLE playwright_execution_profiles
      DROP COLUMN IF EXISTS headless,
      DROP COLUMN IF EXISTS viewport_width,
      DROP COLUMN IF EXISTS viewport_height;
  `);
};
