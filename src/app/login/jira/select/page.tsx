import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { JIRA_OAUTH_BINDING_COOKIE } from "@/modules/auth/jira-oauth-cookie";
import { getJiraSiteSelectionOptions } from "@/modules/auth/jira-site-selection.service";
import { JiraSiteSelector } from "./jira-site-selector";

export default async function JiraSiteSelectionPage({ searchParams }: { searchParams: Promise<{ continuation?: string }> }) {
  const continuation = (await searchParams).continuation?.trim() ?? "";
  const browserBinding = (await cookies()).get(JIRA_OAUTH_BINDING_COOKIE)?.value ?? "";
  if (!continuation || !browserBinding) notFound();
  try {
    const sites = await getJiraSiteSelectionOptions(continuation, browserBinding);
    return <JiraSiteSelector continuation={continuation} sites={sites} />;
  } catch {
    notFound();
  }
}
