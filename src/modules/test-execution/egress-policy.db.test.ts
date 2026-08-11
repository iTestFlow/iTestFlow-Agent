import { afterAll, beforeAll, expect, it } from "vitest";

import { sqlRun } from "@/modules/shared/infrastructure/database/db";
import {
  cleanupFixtures,
  describeDb,
  seedUser,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";
import {
  assertTestExecutionEgressAllowed,
  createWorkspaceEgressRule,
  deleteWorkspaceEgressRule,
  listWorkspaceEgressRules,
  setTestExecutionEgressResolverForTests,
  TestExecutionEgressDeniedError,
  updateWorkspaceEgressRule,
} from "./egress-policy.service";

const workspaceId = uniqueTestId("ws_egress");
const userId = uniqueTestId("usr_egress");
const orgUrl = `https://dev.azure.com/${workspaceId}`;

describeDb("workspace test-execution egress policy", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: workspaceId, orgUrl });
    await seedUser({ id: userId, email: `${userId}@example.com` });
  });

  afterAll(async () => {
    setTestExecutionEgressResolverForTests(null);
    await sqlRun(`DELETE FROM workspace_test_egress_rules WHERE workspace_id = @workspaceId`, { workspaceId });
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [userId] });
  });

  it("defaults to deny and authorizes only a matching enabled rule", async () => {
    setTestExecutionEgressResolverForTests(async () => ["203.0.113.42"]);
    await expect(
      assertTestExecutionEgressAllowed({
        workspaceId,
        targetKind: "api",
        protocol: "https",
        host: "api.example.com",
        port: 443,
      }),
    ).rejects.toBeInstanceOf(TestExecutionEgressDeniedError);

    const rule = await createWorkspaceEgressRule({
      workspaceId,
      actor: userId,
      rule: {
        name: uniqueTestId("Public API"),
        targetKind: "api",
        protocol: "https",
        hostPattern: "203.0.113.0/24",
        portFrom: 443,
        portTo: 443,
        allowPrivateNetwork: false,
        enabled: true,
      },
    });
    // A DNS answer may contain addresses outside a CIDR allowlist. Only the
    // concrete matching address is returned to the socket-pinning adapter.
    setTestExecutionEgressResolverForTests(async () => ["203.0.113.42", "198.51.100.8"]);
    await expect(
      assertTestExecutionEgressAllowed({
        workspaceId,
        targetKind: "api",
        protocol: "https",
        host: "api.example.com",
        port: 443,
      }),
    ).resolves.toEqual({ ruleId: rule.id, resolvedAddresses: ["203.0.113.42"] });
    await expect(
      assertTestExecutionEgressAllowed({
        workspaceId,
        targetKind: "api",
        protocol: "http",
        host: "api.example.com",
        port: 80,
      }),
    ).rejects.toBeInstanceOf(TestExecutionEgressDeniedError);
  });

  it("blocks private, loopback, and link-local resolutions unless the matched rule opts in", async () => {
    const rule = await createWorkspaceEgressRule({
      workspaceId,
      actor: userId,
      rule: {
        name: uniqueTestId("Private DB"),
        targetKind: "database",
        protocol: "tcp",
        hostPattern: "*.internal.example",
        portFrom: 5432,
        portTo: 5432,
        allowPrivateNetwork: false,
        enabled: true,
      },
    });
    setTestExecutionEgressResolverForTests(async () => ["10.20.30.40"]);
    await expect(
      assertTestExecutionEgressAllowed({
        workspaceId,
        targetKind: "database",
        protocol: "tcp",
        host: "orders.internal.example",
        port: 5432,
      }),
    ).rejects.toBeInstanceOf(TestExecutionEgressDeniedError);

    setTestExecutionEgressResolverForTests(async () => ["127.0.0.1"]);
    await expect(
      assertTestExecutionEgressAllowed({
        workspaceId,
        targetKind: "database",
        protocol: "tcp",
        host: "orders.internal.example",
        port: 5432,
      }),
    ).rejects.toBeInstanceOf(TestExecutionEgressDeniedError);

    const enabled = await updateWorkspaceEgressRule({
      workspaceId,
      actor: userId,
      ruleId: rule.id,
      changes: { allowPrivateNetwork: true },
    });
    expect(enabled?.allowPrivateNetwork).toBe(true);
    await expect(
      assertTestExecutionEgressAllowed({
        workspaceId,
        targetKind: "database",
        protocol: "tcp",
        host: "orders.internal.example",
        port: 5432,
      }),
    ).resolves.toMatchObject({ ruleId: rule.id });

    setTestExecutionEgressResolverForTests(async () => ["169.254.169.254"]);
    await expect(
      assertTestExecutionEgressAllowed({
        workspaceId,
        targetKind: "database",
        protocol: "tcp",
        host: "orders.internal.example",
        port: 5432,
      }),
    ).resolves.toMatchObject({ ruleId: rule.id });

    setTestExecutionEgressResolverForTests(async () => ["::1"]);
    await expect(
      assertTestExecutionEgressAllowed({
        workspaceId,
        targetKind: "database",
        protocol: "tcp",
        host: "orders.internal.example",
        port: 5432,
      }),
    ).resolves.toMatchObject({ ruleId: rule.id });
  });

  it("normalizes, lists, disables, and deletes rules within one workspace", async () => {
    const rule = await createWorkspaceEgressRule({
      workspaceId,
      actor: userId,
      rule: {
        name: uniqueTestId("OAuth"),
        targetKind: "oauth",
        protocol: "https",
        hostPattern: "LOGIN.EXAMPLE.COM.",
        portFrom: 443,
        portTo: 443,
        allowPrivateNetwork: false,
        enabled: true,
      },
    });
    expect(rule.hostPattern).toBe("login.example.com");
    expect((await listWorkspaceEgressRules(workspaceId)).some((entry) => entry.id === rule.id)).toBe(true);

    const disabled = await updateWorkspaceEgressRule({
      workspaceId,
      actor: userId,
      ruleId: rule.id,
      changes: { enabled: false },
    });
    expect(disabled?.enabled).toBe(false);
    expect(await deleteWorkspaceEgressRule({ workspaceId, actor: userId, ruleId: rule.id })).toBe(true);
    expect(await deleteWorkspaceEgressRule({ workspaceId, actor: userId, ruleId: rule.id })).toBe(false);
  });
});
