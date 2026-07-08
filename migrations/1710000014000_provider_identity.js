/* eslint-disable camelcase */

/**
 * Adds explicit provider identity to workspaces and projects. Azure DevOps
 * remains the only supported provider; defaults keep existing rows and inserts
 * behavior-compatible while future providers get a concrete resolution column.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn("workspaces", {
    provider_id: { type: "text", notNull: true, default: "azure-devops" },
  });
  pgm.addColumn("projects", {
    provider_id: { type: "text", notNull: true, default: "azure-devops" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("projects", "provider_id");
  pgm.dropColumn("workspaces", "provider_id");
};
