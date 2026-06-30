import { describe, expect, it } from "vitest"

import { resolveLoginDestination } from "@/app/login/login-destination"

describe("resolveLoginDestination", () => {
  it("lands on the dashboard when no next path is provided", () => {
    expect(resolveLoginDestination(null)).toBe("/dashboards")
  })

  it("preserves a safe in-app next path", () => {
    expect(resolveLoginDestination("/settings?tab=credentials")).toBe(
      "/settings?tab=credentials",
    )
  })

  it("normalizes the home route to the dashboard", () => {
    expect(resolveLoginDestination("/")).toBe("/dashboards")
  })

  it("rejects protocol-relative destinations", () => {
    expect(resolveLoginDestination("//example.com")).toBe("/dashboards")
  })
})
