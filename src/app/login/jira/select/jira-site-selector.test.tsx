// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

import { JiraSiteSelector } from "./jira-site-selector";

const sites = [
  { id: "cloud-a", name: "Quality A", url: "https://a.atlassian.net" },
  { id: "cloud-b", name: "Quality B", url: "https://b.atlassian.net" },
];

describe("JiraSiteSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets the user choose a site and redirects after completion", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, returnTo: "/settings" }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<JiraSiteSelector continuation="continuation" sites={sites} />);
    await user.click(screen.getByLabelText(/Quality B/));
    await user.click(screen.getByRole("button", { name: "Connect selected site" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/jira/select", expect.objectContaining({
      method: "POST", body: JSON.stringify({ continuation: "continuation", cloudId: "cloud-b" }),
    }));
    expect(replace).toHaveBeenCalledWith("/settings");
  });

  it("recovers from a network failure and leaves retry enabled", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret network detail")));
    const user = userEvent.setup();
    render(<JiraSiteSelector continuation="continuation" sites={sites} />);
    await user.click(screen.getByRole("button", { name: "Connect selected site" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("unavailable");
    expect(screen.getByRole("button", { name: "Connect selected site" })).toBeEnabled();
    expect(screen.getByRole("alert")).not.toHaveTextContent("secret network detail");
  });
});
