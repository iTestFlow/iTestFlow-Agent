import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { middleware } from "@/middleware";

describe("retired page routing", () => {
  it("lets a signed-out request reach the App Router 404", () => {
    const response = middleware(new NextRequest("http://localhost/test-execution-effort"));

    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
