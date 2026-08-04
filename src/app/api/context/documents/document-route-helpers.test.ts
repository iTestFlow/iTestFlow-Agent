import { describe, expect, it } from "vitest";

import {
  documentDownloadHeaders,
  parseDocumentPagination,
  parseDocumentScopeParam,
  parseDocumentUploadFields,
  safeDocumentDownloadName,
} from "./document-route-helpers";

const scope = {
  workspaceId: "workspace-1",
  projectId: "project-1",
  azureProjectId: "azure-project-1",
  azureProjectName: "Project One",
  azureOrganizationUrl: "https://dev.azure.com/example",
};

describe("document route helpers", () => {
  it("accepts a valid JSON scope and rejects malformed scope input", () => {
    expect(parseDocumentScopeParam(JSON.stringify(scope))).toMatchObject({ success: true, data: scope });
    expect(parseDocumentScopeParam("not-json")).toMatchObject({ success: false });
    expect(parseDocumentScopeParam(null)).toMatchObject({ success: false });
  });

  it("bounds document list pagination", () => {
    expect(parseDocumentPagination({ page: "2", pageSize: "25" })).toEqual({
      success: true,
      data: { page: 2, pageSize: 25, offset: 25 },
    });
    expect(parseDocumentPagination({ page: "0", pageSize: "200" })).toMatchObject({ success: false });
  });

  it("validates multipart metadata without accepting hidden fields", () => {
    expect(parseDocumentUploadFields({
      scope: JSON.stringify(scope),
      tags: JSON.stringify(["release", "policy"]),
      languageHint: "en",
    })).toMatchObject({ success: true, data: { scope, tags: ["release", "policy"], languageHint: "en" } });
    expect(parseDocumentUploadFields({ scope: JSON.stringify(scope), storageKey: "outside" })).toMatchObject({ success: false });
  });

  it("makes document download headers safe for a user-provided filename", () => {
    const fileName = safeDocumentDownloadName('report\r\nX-Evil: yes.pdf');
    expect(fileName).not.toMatch(/[\r\n]/);
    const headers = documentDownloadHeaders({ fileName, byteSize: 12 });
    expect(headers["Content-Disposition"]).toContain("attachment");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("keeps the bare Content-Disposition filename ASCII-only so Response construction cannot throw", () => {
    // Headers/Response reject any code point above U+00FF in a bare ByteString
    // header value. A raw smart quote, Arabic, or CJK filename in filename=
    // (without this fix) throws a TypeError and 500s the download route.
    const smartQuoteName = "Report’s Q3 Summary.pdf";
    const smartQuoteHeaders = documentDownloadHeaders({ fileName: smartQuoteName, byteSize: 1 });
    expect(() => new Response("x", { headers: smartQuoteHeaders })).not.toThrow();
    expect(smartQuoteHeaders["Content-Disposition"]).toBe(
      `attachment; filename="Report_s Q3 Summary.pdf"; filename*=UTF-8''${encodeURIComponent(smartQuoteName)}`,
    );

    const arabicName = "تقرير.pdf";
    const arabicHeaders = documentDownloadHeaders({ fileName: arabicName, byteSize: 1 });
    expect(() => new Response("x", { headers: arabicHeaders })).not.toThrow();
    expect(arabicHeaders["Content-Disposition"]).toBe(
      `attachment; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(arabicName)}`,
    );

    const cjkName = "报告書.pdf";
    const cjkHeaders = documentDownloadHeaders({ fileName: cjkName, byteSize: 1 });
    expect(() => new Response("x", { headers: cjkHeaders })).not.toThrow();
    for (const headers of [smartQuoteHeaders, arabicHeaders, cjkHeaders]) {
      const bareFilename = /filename="([^"]*)"/.exec(headers["Content-Disposition"])?.[1] ?? "";
      expect(bareFilename).toMatch(/^[\x20-\x7E]*$/);
      expect(bareFilename.length).toBeGreaterThan(0);
    }
  });
});
