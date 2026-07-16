// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  KnowledgeCategoryFilterButton,
  type KnowledgeCategoryVisualKey,
  type KnowledgeDisplayEntry,
  KnowledgeEntryCard,
} from "./knowledge-entry-card"

afterEach(cleanup)

function knowledgeEntry(
  overrides: Partial<KnowledgeDisplayEntry> = {},
): KnowledgeDisplayEntry {
  return {
    key: "module:visitor-details",
    highlightIdentity: "module:visitor-details",
    category: "module",
    categoryLabel: "Modules",
    badge: "Module",
    title: "Visitor Details Retrieval",
    description: "Retrieves visitor details from the configured providers and handles fallback behavior.",
    evidence: "The visitor details service is called after the sponsor continues.",
    sourceWorkItemIds: ["355786", "356964"],
    meta: [],
    searchText: "visitor details retrieval",
    details: [
      { id: "id", label: "ID", value: "mod-visitor-details-retrieval" },
      { id: "name", label: "Name", value: "Visitor Details Retrieval" },
    ],
    evidenceItems: [
      {
        sourceWorkItemId: "355786",
        sourceField: "acceptanceCriteria",
        quote: "The sponsor continues to visitor details retrieval.",
      },
      {
        sourceWorkItemId: "356964",
        sourceField: "description",
        quote: "The service calls the configured data providers.",
      },
      {
        sourceWorkItemId: "355786",
        sourceField: "title",
        quote: "Retrieve and Display Visitor Information",
      },
      {
        sourceWorkItemId: "356964",
        sourceField: "title",
        quote: "Retrieve Visitor Details from Configured Providers",
      },
    ],
    ...overrides,
  }
}

function disclosure(title: string) {
  return screen.getByRole("button", { name: new RegExp(`details for ${title}`, "i") })
}

describe("KnowledgeCategoryFilterButton", () => {
  const categoryVisuals: Array<{
    iconKey: KnowledgeCategoryVisualKey
    label: string
    count: number
    iconClass: string
  }> = [
    { iconKey: "all", label: "All", count: 73, iconClass: "lucide-layout-grid" },
    { iconKey: "module", label: "Modules", count: 5, iconClass: "lucide-box" },
    { iconKey: "businessRule", label: "Business Rules", count: 23, iconClass: "lucide-list-checks" },
    { iconKey: "stateTransition", label: "State Transitions", count: 3, iconClass: "lucide-git-branch" },
    { iconKey: "glossary", label: "Glossary", count: 33, iconClass: "lucide-book-open" },
    { iconKey: "dependency", label: "Dependencies", count: 9, iconClass: "lucide-network" },
  ]

  it("renders all canonical decorative icons without changing accessible filter names", () => {
    render(
      <div>
        {categoryVisuals.map((category, index) => (
          <KnowledgeCategoryFilterButton
            key={category.iconKey}
            iconKey={category.iconKey}
            label={category.label}
            count={category.count}
            active={index === 0}
            onClick={vi.fn()}
          />
        ))}
      </div>,
    )

    for (const [index, category] of categoryVisuals.entries()) {
      const button = screen.getByRole("button", {
        name: new RegExp(`${category.label}\\s*${category.count}`, "i"),
      })
      const icon = button.querySelector(`svg.${category.iconClass}`)

      expect(button).toHaveAttribute("aria-pressed", String(index === 0))
      expect(button).toHaveAccessibleName(`${category.label} ${category.count}`)
      expect(icon).not.toBeNull()
      expect(icon).toHaveAttribute("aria-hidden", "true")
    }
  })

  it("keeps a touch-sized mobile target while returning to compact desktop density", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()

    render(
      <KnowledgeCategoryFilterButton
        iconKey="module"
        label="Modules"
        count={48}
        active
        onClick={onClick}
      />,
    )

    const button = screen.getByRole("button", { name: /Modules\s*48/i })
    expect(button).toHaveAttribute("aria-pressed", "true")
    expect(button).toHaveClass("h-11", "lg:h-10")
    expect(within(button).getByText("Modules")).toHaveClass("whitespace-nowrap")

    button.focus()
    expect(button).toHaveFocus()
    await user.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it.each([
    ["module", "module", "Modules", "Module", "lucide-box"],
    ["businessRule", "businessRule", "Business Rules", "Business Rule", "lucide-list-checks"],
    ["stateTransition", "stateTransition", "State Transitions", "State Transition", "lucide-git-branch"],
    ["glossary", "glossary", "Glossary", "Glossary", "lucide-book-open"],
    ["dependency", "dependency", "Dependencies", "Dependency", "lucide-network"],
  ] as const)(
    "uses the same %s icon in filters and knowledge cards",
    (iconKey, category, categoryLabel, badge, iconClass) => {
      const entry = knowledgeEntry({ category, categoryLabel, badge })

      render(
        <div>
          <KnowledgeCategoryFilterButton
            iconKey={iconKey}
            label={categoryLabel}
            count={1}
            active={false}
            onClick={vi.fn()}
          />
          <KnowledgeEntryCard entry={entry} />
        </div>,
      )

      const filter = screen.getByRole("button", { name: new RegExp(`${categoryLabel}\\s*1`, "i") })
      const cardTrigger = disclosure(entry.title)
      expect(filter.querySelector(`svg.${iconClass}`)).not.toBeNull()
      expect(cardTrigger.querySelector(`svg.${iconClass}`)).not.toBeNull()
    },
  )
})

describe("KnowledgeEntryCard", () => {
  it("keeps the enhanced collapsed hierarchy accessible without relying on its colors", async () => {
    const user = userEvent.setup()
    const entry = knowledgeEntry()

    render(<KnowledgeEntryCard entry={entry} />)

    const trigger = disclosure(entry.title)
    const categoryText = within(trigger).getByText(entry.badge)
    const categoryBadge = categoryText.closest('[data-slot="badge"]')

    expect(categoryBadge).not.toBeNull()
    expect(categoryBadge).toHaveTextContent(entry.badge)
    expect(categoryBadge?.querySelector('[aria-hidden="true"]')).not.toBeNull()
    expect(trigger).toHaveAccessibleName(`Show details for ${entry.title}`)
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(within(trigger).getByText("2 sources")).toBeVisible()
    expect(within(trigger).getByText("4 evidence excerpts")).toBeVisible()
    expect(screen.queryByText("mod-visitor-details-retrieval")).toBeNull()

    await user.hover(trigger)
    expect(trigger).toHaveAttribute("aria-expanded", "false")

    trigger.focus()
    expect(trigger).toHaveFocus()
    await user.keyboard("{Enter}")

    expect(trigger).toHaveAccessibleName(`Hide details for ${entry.title}`)
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(within(trigger).getByText("2 sources")).toBeVisible()
    expect(within(trigger).getByText("4 evidence excerpts")).toBeVisible()
  })

  it("shows a concise summary and keeps cards collapsed and independently keyboard-expandable", async () => {
    const user = userEvent.setup()
    const first = knowledgeEntry({ key: "module:first", highlightIdentity: "module:first" })
    const second = knowledgeEntry({
      key: "module:second",
      highlightIdentity: "module:second",
      title: "Visa Insurance",
      description: "Covers the visitor visa insurance workflow.",
    })

    render(
      <div>
        <KnowledgeEntryCard entry={first} highlighted />
        <KnowledgeEntryCard entry={second} />
      </div>,
    )

    expect(screen.getAllByText("Module")).toHaveLength(2)
    expect(screen.getByText(first.title)).toHaveClass("text-balance")
    expect(screen.getByText(first.description)).toBeVisible()
    expect(screen.getAllByText("2 sources")).toHaveLength(2)
    expect(screen.getAllByText("4 evidence excerpts")).toHaveLength(2)
    expect(screen.getByText("Updated review result")).toBeVisible()
    expect(screen.getByRole("article", { name: /updated review result/i })).toBeTruthy()
    expect(screen.queryByText("mod-visitor-details-retrieval")).toBeNull()

    const firstTrigger = disclosure(first.title)
    const secondTrigger = disclosure(second.title)
    expect(firstTrigger).toHaveAttribute("aria-expanded", "false")
    expect(secondTrigger).toHaveAttribute("aria-expanded", "false")
    expect(firstTrigger).toHaveAttribute("aria-controls")

    firstTrigger.focus()
    await user.keyboard("{Enter}")
    expect(firstTrigger).toHaveAttribute("aria-expanded", "true")
    expect(secondTrigger).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByText("mod-visitor-details-retrieval")).toBeVisible()

    secondTrigger.focus()
    await user.keyboard(" ")
    expect(firstTrigger).toHaveAttribute("aria-expanded", "true")
    expect(secondTrigger).toHaveAttribute("aria-expanded", "true")

    await user.keyboard(" ")
    expect(secondTrigger).toHaveAttribute("aria-expanded", "false")
    expect(firstTrigger).toHaveAttribute("aria-expanded", "true")
  })

  it("uses contained semantic panels and card-width container breakpoints when expanded", async () => {
    const user = userEvent.setup()
    const entry = knowledgeEntry()

    render(<KnowledgeEntryCard entry={entry} />)
    await user.click(disclosure(entry.title))

    const detailsHeading = screen.getByRole("heading", { name: "Knowledge details" })
    const evidenceHeading = screen.getByRole("heading", { name: "Verified source evidence" })
    const detailsPanel = detailsHeading.closest("section")
    const evidencePanel = evidenceHeading.closest("section")
    const panelLayout = detailsPanel?.parentElement

    expect(detailsPanel).not.toBeNull()
    expect(evidencePanel).not.toBeNull()
    expect(panelLayout).toBe(evidencePanel?.parentElement)
    expect(panelLayout).toHaveClass("grid", "grid-cols-[minmax(0,1fr)]")
    expect(panelLayout).toHaveClass("knowledge-entry__expanded")
    expect(detailsPanel).toHaveClass("min-w-0", "max-w-full", "overflow-hidden", "rounded-lg", "border")
    expect(evidencePanel).toHaveClass("min-w-0", "max-w-full", "overflow-hidden", "rounded-lg", "border")

    const detailsIcon = detailsHeading.parentElement?.querySelector("svg")
    const evidenceIcon = evidenceHeading.parentElement?.querySelector("svg")
    expect(detailsIcon).toHaveAttribute("aria-hidden", "true")
    expect(evidenceIcon).toHaveAttribute("aria-hidden", "true")

    const definitionList = detailsPanel?.querySelector("dl")
    expect(definitionList).not.toBeNull()
    expect(definitionList?.querySelectorAll("dt")).toHaveLength(2)
    expect(definitionList?.querySelectorAll("dd")).toHaveLength(2)
    expect(within(detailsPanel as HTMLElement).getByRole("heading", { name: "Source work items" })).toBeVisible()

    const quotes = evidencePanel?.querySelectorAll("blockquote") ?? []
    expect(quotes).toHaveLength(3)
    expect(quotes[0]).toHaveTextContent("The sponsor continues to visitor details retrieval.")
  })

  it("groups exact field-and-trimmed-quote matches and progressively reveals evidence", async () => {
    const user = userEvent.setup()
    const entry = knowledgeEntry({
      sourceWorkItemIds: ["900"],
      evidenceItems: [
        { sourceWorkItemId: "101", sourceField: "description", quote: "  Shared supported statement.  " },
        { sourceWorkItemId: "102", sourceField: "description", quote: "Shared supported statement." },
        { sourceWorkItemId: "103", sourceField: "title", quote: "Shared supported statement." },
        { sourceWorkItemId: "104", sourceField: "description", quote: "Third evidence group." },
        { sourceWorkItemId: "105", sourceField: "description", quote: "Fourth evidence group." },
        { sourceWorkItemId: "106", sourceField: "acceptanceCriteria", quote: "Fifth evidence group." },
      ],
    })

    render(<KnowledgeEntryCard entry={entry} />)
    await user.click(disclosure(entry.title))

    // Whitespace-only quote differences merge, while the same quote under a
    // different source field remains a distinct evidence group.
    expect(screen.getAllByText(/Shared supported statement\./)).toHaveLength(2)
    expect(screen.getAllByText(/#101/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/#102/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/#103/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Third evidence group\./)).toBeVisible()
    expect(screen.queryByText(/Fourth evidence group\./)).toBeNull()
    expect(screen.queryByText(/Fifth evidence group\./)).toBeNull()

    const showAll = screen.getByRole("button", { name: /Show all 5 evidence excerpts/i })
    await user.click(showAll)
    expect(screen.getByText(/Fourth evidence group\./)).toBeVisible()
    expect(screen.getByText(/Fifth evidence group\./)).toBeVisible()

    await user.click(disclosure(entry.title))
    expect(screen.queryByText(/Fourth evidence group\./)).toBeNull()

    await user.click(disclosure(entry.title))
    expect(screen.queryByText(/Fourth evidence group\./)).toBeNull()
    expect(screen.queryByText(/Fifth evidence group\./)).toBeNull()
    expect(screen.getByRole("button", { name: /Show all 5 evidence excerpts/i })).toBeVisible()

    await user.click(screen.getByRole("button", { name: /Show all 5 evidence excerpts/i }))
    await user.click(screen.getByRole("button", { name: /Show fewer evidence excerpts/i }))
    expect(screen.queryByText(/Fourth evidence group\./)).toBeNull()
    expect(screen.queryByText(/Fifth evidence group\./)).toBeNull()
  })

  it("uses the legacy evidence fallback and bounds long source badge lists", async () => {
    const user = userEvent.setup()
    const sourceWorkItemIds = Array.from({ length: 14 }, (_, index) => String(index + 1))
    const entry = knowledgeEntry({
      sourceWorkItemIds,
      evidence: "Legacy evidence remains available for migrated knowledge.",
      evidenceItems: undefined,
      details: undefined,
      meta: ["Visitor Services"],
    })

    render(<KnowledgeEntryCard entry={entry} />)

    expect(screen.getByText("14 sources")).toBeVisible()
    expect(screen.getByText("1 evidence excerpt")).toBeVisible()
    expect(screen.queryByText("#14")).toBeNull()
    expect(screen.queryByText(entry.evidence)).toBeNull()

    await user.click(disclosure(entry.title))
    const overflowBadge = screen.getByLabelText(/more source work items/i)
    expect(overflowBadge).toHaveTextContent(/^\+\d+$/)
    expect(overflowBadge).toHaveAccessibleName(/#14/)
    expect(screen.queryByText("#14")).toBeNull()
    const fallback = screen.getByText(entry.evidence)
    expect(fallback).toBeVisible()
    expect(fallback.closest("blockquote")).not.toBeNull()
    expect(screen.queryByRole("heading", { name: "Knowledge details" })).toBeNull()
    expect(screen.getByRole("heading", { name: "Source work items" })).toBeVisible()
  })

  it("omits empty information and evidence panels while letting the remaining panel span the card", async () => {
    const user = userEvent.setup()
    const evidenceOnly = knowledgeEntry({
      key: "module:evidence-only",
      highlightIdentity: "module:evidence-only",
      details: undefined,
      sourceWorkItemIds: [],
    })

    const { unmount } = render(<KnowledgeEntryCard entry={evidenceOnly} />)
    await user.click(disclosure(evidenceOnly.title))

    expect(screen.queryByRole("heading", { name: "Knowledge details" })).toBeNull()
    expect(screen.queryByRole("heading", { name: "Source work items" })).toBeNull()
    expect(screen.getByRole("heading", { name: "Verified source evidence" }).closest("section")).toHaveClass(
      "knowledge-entry__panel--full",
    )

    unmount()

    const informationOnly = knowledgeEntry({
      key: "module:information-only",
      highlightIdentity: "module:information-only",
      evidence: "",
      evidenceItems: [],
    })
    render(<KnowledgeEntryCard entry={informationOnly} />)
    await user.click(disclosure(informationOnly.title))

    expect(screen.queryByRole("heading", { name: "Verified source evidence" })).toBeNull()
    expect(screen.getByRole("heading", { name: "Knowledge details" }).closest("section")).toHaveClass(
      "knowledge-entry__panel--full",
    )
  })

  it("contains long unbroken titles, detail values, and quotes at every card layer", async () => {
    const user = userEvent.setup()
    const longTitle = `Knowledge${"T".repeat(180)}`
    const longDetail = `Detail${"D".repeat(220)}`
    const longQuote = `Evidence${"Q".repeat(240)}`
    const entry = knowledgeEntry({
      title: longTitle,
      description: longDetail,
      details: [{ id: "long", label: "Long detail", value: longDetail }],
      evidenceItems: [{ sourceWorkItemId: "355786", sourceField: "description", quote: longQuote }],
    })

    render(<KnowledgeEntryCard entry={entry} />)

    const article = screen.getByRole("article")
    const trigger = disclosure(longTitle)
    const summaryLayout = trigger.querySelector(".knowledge-entry__summary")
    expect(article).toHaveClass("knowledge-entry", "w-full", "min-w-0", "max-w-full")
    expect(article.querySelector('[data-slot="accordion"]')).toHaveClass("w-full", "min-w-0", "max-w-full")
    expect(article.querySelector('[data-slot="accordion-item"]')).toHaveClass("w-full", "min-w-0", "max-w-full")
    expect(trigger).toHaveClass("w-full", "min-w-0", "max-w-full")
    expect(summaryLayout).toHaveClass("grid", "grid-cols-[minmax(0,1fr)]")
    expect(screen.getByText(longTitle)).toHaveClass("[overflow-wrap:anywhere]")
    expect(
      screen.getAllByText(longDetail).find((element) => element.tagName === "SPAN"),
    ).toHaveClass("[overflow-wrap:anywhere]")

    await user.click(trigger)

    const detailValue = screen.getAllByText(longDetail).find((element) => element.tagName === "DD")
    const quote = screen.getByText(longQuote).closest("blockquote")
    const expandedContent = article.querySelector('[data-slot="accordion-content"]')?.firstElementChild
    expect(detailValue).toHaveClass("min-w-0", "max-w-full", "[overflow-wrap:anywhere]")
    expect(quote).toHaveClass("min-w-0", "max-w-full", "[overflow-wrap:anywhere]")
    expect(expandedContent).toHaveClass("min-w-0", "max-w-full")
  })
})
