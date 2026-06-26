/**
 * Enable or disable a bootstrapped Azure org (soft delete).
 *
 * Bootstrap (`BOOTSTRAP_AZURE_ORGS`) is additive — it never removes an org. This
 * is the explicit, reversible way to take an org out of service: disabling sets
 * the workspace to `status='inactive'`, which removes it from the login picker
 * and every workspace-resolution path, while preserving all of its projects,
 * knowledge, credentials and members. Re-enabling restores access.
 *
 * Run:
 *   npm run org:disable -- <orgUrlOrName>
 *   npm run org:enable  -- <orgUrlOrName>
 *
 * Accepts an org name ("contoso") or a full URL ("https://dev.azure.com/contoso").
 * Env: DATABASE_URL.
 */
import { normalizeAzureOrg } from "@/modules/auth/bootstrap.service";
import { setWorkspaceStatusByOrgUrl } from "@/modules/workspace/workspace.service";

async function main() {
  const action = process.argv[2];
  const rawOrg = process.argv[3];

  if ((action !== "enable" && action !== "disable") || !rawOrg) {
    console.error("Usage: npm run org:disable -- <orgUrlOrName>   (or org:enable)");
    process.exitCode = 1;
    return;
  }

  const { url } = normalizeAzureOrg(rawOrg);
  const status = action === "disable" ? "inactive" : "active";
  const workspace = await setWorkspaceStatusByOrgUrl(url, status);

  if (!workspace) {
    console.error(`No org found for ${url}. Nothing changed.`);
    process.exitCode = 1;
    return;
  }

  console.log(`${action === "disable" ? "Disabled" : "Enabled"} ${workspace.name} (${workspace.azureOrgUrl}).`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
