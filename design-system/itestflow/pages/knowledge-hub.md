# Knowledge Hub Page Overrides

> **PROJECT:** iTestFlow
> **PAGE:** `/knowledge-hub`
> **PAGE TYPE:** Enterprise knowledge explorer and build workflow
>
> These rules override `../MASTER.md` only for Knowledge Hub. Existing iTestFlow
> semantic color tokens, Inter typography, shadcn/Radix components, and Lucide
> icons remain authoritative.

## Experience Goals

- Make search and knowledge discovery the dominant read path.
- Keep source provenance, health, and freshness visible without competing with content.
- Use progressive disclosure for build, health, log, and export operations.
- Preserve a dense enterprise layout while keeping controls readable and keyboard accessible.

## Layout

- Maximum content width: `1440px`.
- Order: page purpose → Hub/Build mode → freshness summary → operations → Explorer/Context.
- Use compact 4/8px spacing increments and 16px section gaps.
- At `375px`, stack filters and metrics; wrap category filters so every option remains visible.
- At `768px`, use two-column summary metrics and full-width content.
- At `1024px+`, use the persistent sidebar and a readable content column.

## Navigation and Search

- Hub/Build and Explorer/Context controls must use semantic tabs with visible focus states.
- Use short mobile tab labels while preserving full accessible names at larger breakpoints.
- Search fields require visible or programmatic labels and leading Lucide search icons.
- Search results update while typing; no submit button is required.
- Category filters wrap at phone/tablet widths and expose the selected state with `aria-pressed`.

## States

- Loading uses skeletons shaped like the final content and an announced `role="status"`.
- Empty compiled knowledge explains that owners/admins can use Build Knowledge.
- Empty search results offer a clear-filters action.
- Errors use `role="alert"` and preserve existing retry behavior.
- Disabled build actions remain visibly and semantically disabled.

## Content and Performance

- Knowledge entries retain source IDs, evidence, and metadata hierarchy.
- Long off-screen entry lists use `content-visibility: auto`.
- Tables scroll inside their own container; the page itself must not overflow horizontally.
- Avoid decorative motion. Respect `prefers-reduced-motion`.

## Verification

- Check widths: `375px`, `768px`, `1024px`, and `1440px`.
- Verify Hub/Build and Explorer/Context keyboard tab behavior.
- Verify search, category reset, pagination, health/log/export controls, loading, and empty states.
- Confirm light/dark contrast and no page-level horizontal scrolling.
