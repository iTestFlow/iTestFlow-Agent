/* eslint-disable camelcase */

/**
 * Renames the Project Knowledge job type from 'project_knowledge_v4' to the
 * version-neutral 'project_knowledge_build'. The queue type describes the
 * operation, not the compiler contract lineage (which stays versioned in
 * compiler_contract_version), so it should not change when the contract does.
 *
 * jobs.job_type must follow the code constant or in-flight rows become
 * unreadable: getProjectKnowledgeJob rejects rows whose job_type differs from
 * PROJECT_KNOWLEDGE_JOB, which would 404 job polling and purge the client's
 * saved job id. worker_instances.capabilities_json is rewritten too so
 * hasHealthyWorkerCapability (exact-match jsonb ?) does not report the build
 * as unavailable during the window before a new-code worker re-registers.
 *
 * A pure string rename in both directions, so down is symmetric.
 */

exports.shorthands = undefined;

const renameCapability = (from, to) => `
    UPDATE worker_instances
    SET capabilities_json = sub.new_caps
    FROM (
      SELECT id, COALESCE(jsonb_agg(to_jsonb(new_cap) ORDER BY new_cap), '[]'::jsonb) AS new_caps
      FROM (
        SELECT worker_instances.id,
               CASE WHEN cap = '${from}' THEN '${to}' ELSE cap END AS new_cap
        FROM worker_instances,
             jsonb_array_elements_text(capabilities_json) AS cap
      ) elements
      GROUP BY id
    ) sub
    WHERE worker_instances.id = sub.id
      AND worker_instances.capabilities_json ? '${from}';
`;

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE jobs
    SET job_type = 'project_knowledge_build'
    WHERE job_type = 'project_knowledge_v4';
${renameCapability("project_knowledge_v4", "project_knowledge_build")}
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE jobs
    SET job_type = 'project_knowledge_v4'
    WHERE job_type = 'project_knowledge_build';
${renameCapability("project_knowledge_build", "project_knowledge_v4")}
  `);
};
