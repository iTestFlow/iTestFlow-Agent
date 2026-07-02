import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import Loading from "@/app/loading"

describe("Loading", () => {
  it("renders an accessible route loading status", () => {
    const markup = renderToStaticMarkup(<Loading />)

    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain('aria-label="Loading page"')
    expect(markup).toContain("Loading page…")
    expect(markup).toContain("Preparing the next view.")
  })
})
