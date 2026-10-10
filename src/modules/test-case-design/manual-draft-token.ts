import "server-only";

import { TEST_CASE_OUTPUT_CONTRACT_VERSION } from "./test-case-basis";
import { SourceManifestSchema, sourceManifestHash } from "./generation-grounding";

import { decryptSecret, encryptSecret, type EncryptedSecret } from "@/modules/security/encryption.service";
import { AppErrorCode } from "@/modules/shared/errors/app-error";
import { AcceptanceCriteriaError, type AcceptanceCriteriaContract } from "./acceptance-criteria-contract";

const PURPOSE = "test-case-design-manual-draft";
const EXPIRY_MS = 24 * 60 * 60 * 1000;

export type ManualDraftBinding = {
  userId: string;
  workspaceId: string;
  projectId: string;
  integrationProvider: string;
  storyId: string;
};

export function createManualDraftToken(binding: ManualDraftBinding, contract: AcceptanceCriteriaContract, sourceManifest: readonly string[], now = Date.now()) {
  const payload = {
    purpose: PURPOSE,
    contractVersion: contract.version,
    outputContractVersion: TEST_CASE_OUTPUT_CONTRACT_VERSION,
    sourceManifestHash: sourceManifestHash(SourceManifestSchema.parse(sourceManifest)),
    sourceHash: contract.sourceHash,
    ...binding,
    expiresAt: now + EXPIRY_MS,
  };
  return Buffer.from(JSON.stringify(encryptSecret(JSON.stringify(payload)))).toString("base64url");
}

export type VerifiedManualDraft = { contractVersion: string; sourceHash: string; sourceManifestHash: string };

export function verifyManualDraftManifest(draft: VerifiedManualDraft, manifest: unknown): string[] {
  const parsed = SourceManifestSchema.safeParse(manifest);
  if (!parsed.success || sourceManifestHash(parsed.data) !== draft.sourceManifestHash) {
    throw new AcceptanceCriteriaError(AppErrorCode.AcceptanceCriteriaDraftInvalid, "This manual draft source manifest is missing or changed. Prepare a fresh prompt; your pasted response remains available to copy.");
  }
  return parsed.data;
}

export function verifyManualDraftContract(draft: VerifiedManualDraft, contract: AcceptanceCriteriaContract) {
  if (draft.contractVersion !== contract.version || draft.sourceHash !== contract.sourceHash) {
    throw new AcceptanceCriteriaError(AppErrorCode.AcceptanceCriteriaDraftStale, "This manual draft expired or the story changed. Prepare a fresh prompt; your pasted response remains available to copy.");
  }
}

export function verifyManualDraftToken(token: string, binding: ManualDraftBinding, contract?: AcceptanceCriteriaContract, now = Date.now()): VerifiedManualDraft {
  let payload: Record<string, unknown>;
  try {
    if (token.length > 8192) throw new Error("oversized");
    const envelope = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as EncryptedSecret;
    payload = JSON.parse(decryptSecret(envelope)) as Record<string, unknown>;
  } catch {
    throw new AcceptanceCriteriaError(AppErrorCode.AcceptanceCriteriaDraftInvalid, "This manual draft token is invalid. Prepare a fresh prompt before submitting.");
  }
  if (payload.purpose !== PURPOSE || Object.entries(binding).some(([key, value]) => payload[key] !== value)) {
    throw new AcceptanceCriteriaError(AppErrorCode.AcceptanceCriteriaDraftInvalid, "This manual draft belongs to a different user, workspace, project, provider, or story. Prepare a fresh prompt before submitting.");
  }
  if (typeof payload.expiresAt !== "number" || payload.expiresAt <= now) {
    throw new AcceptanceCriteriaError(AppErrorCode.AcceptanceCriteriaDraftStale, "This manual draft expired or the story changed. Prepare a fresh prompt; your pasted response remains available to copy.");
  }
  if (typeof payload.contractVersion !== "string" || typeof payload.sourceHash !== "string") {
    throw new AcceptanceCriteriaError(AppErrorCode.AcceptanceCriteriaDraftInvalid, "This manual draft token is invalid. Prepare a fresh prompt before submitting.");
  }
  if (payload.outputContractVersion !== TEST_CASE_OUTPUT_CONTRACT_VERSION || typeof payload.sourceManifestHash !== "string") {
    throw new AcceptanceCriteriaError(AppErrorCode.AcceptanceCriteriaDraftStale, "This manual draft uses an older output contract. Prepare a fresh prompt; your pasted response remains available to copy.");
  }
  const draft = { contractVersion: payload.contractVersion, sourceHash: payload.sourceHash, sourceManifestHash: payload.sourceManifestHash };
  if (contract) verifyManualDraftContract(draft, contract);
  return draft;
}
