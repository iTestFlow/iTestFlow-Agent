// The persisted job-type / worker-capability string for Project Knowledge builds.
// Lives in its own module because both project-knowledge-jobs.service.ts and
// project-knowledge-operation-gate.ts need it, and the service imports the gate —
// defining it in either would force a duplicate literal or an import cycle.
// Renaming this value requires a data migration for existing jobs.job_type rows
// (see migrations/1710000021000_rename_project_knowledge_job_type.js).
export const PROJECT_KNOWLEDGE_JOB = "project_knowledge_build";
