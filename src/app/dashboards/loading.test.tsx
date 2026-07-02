import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import DashboardsLoading from "@/app/dashboards/loading"

describe("DashboardsLoading", () => {
  it("renders the dashboard shell and an accessible loading status", () => {
    const markup = renderToStaticMarkup(<DashboardsLoading />)

    expect(markup).toContain("<h1")
    expect(markup).toContain(">Dashboards</h1>")
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-label="Preparing your dashboard"')
    expect(markup).toContain(">Preparing your dashboard</span>")
  })
})
