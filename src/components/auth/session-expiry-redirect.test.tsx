// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionExpiryRedirect } from "@/components/auth/session-expiry-redirect";

const ORIGIN = "http://localhost:3000";

// jsdom Location members are unforgeable (spyOn fails), so replace the whole global
// with a plain object exposing exactly what the interceptor reads. The global
// afterEach unstubs it.
function stubLocation({ pathname = "/dashboards", search = "" } = {}) {
  const assign = vi.fn();
  vi.stubGlobal("location", { origin: ORIGIN, pathname, search, assign });
  return assign;
}

// Must be stubbed BEFORE render: the effect captures window.fetch as the "original".
function stubFetch(status: number, headers?: HeadersInit) {
  const response = new Response(null, { status, headers });
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, response };
}

afterEach(() => cleanup());

describe("SessionExpiryRedirect", () => {
  it("redirects a 401 from a relative /api/ string to /login, preserving the current location", async () => {
    const { fetchMock, response } = stubFetch(401);
    const assign = stubLocation({ pathname: "/projects/7", search: "?tab=runs" });
    render(<SessionExpiryRedirect />);

    const result = await window.fetch("/api/x?a=1");

    // The underlying request still runs and its response is returned untouched.
    expect(fetchMock).toHaveBeenCalledWith("/api/x?a=1");
    expect(result).toBe(response);
    expect(assign).toHaveBeenCalledExactlyOnceWith(
      `/login?next=${encodeURIComponent("/projects/7?tab=runs")}`,
    );

    // The redirecting latch prevents a second navigation from parallel 401s.
    await window.fetch("/api/y");
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("does not redirect a 401 marked as an integration error", async () => {
    const { response } = stubFetch(401, { "x-itf-error-scope": "integration" });
    const assign = stubLocation({ pathname: "/dashboards", search: "" });
    render(<SessionExpiryRedirect />);

    await expect(window.fetch("/api/azure-devops/profile")).resolves.toBe(response);
    expect(assign).not.toHaveBeenCalled();
  });

  it("resolves Request and URL inputs via their absolute-url branches", async () => {
    stubFetch(401);
    const assign = stubLocation({ pathname: "/settings", search: "" });
    const expected = `/login?next=${encodeURIComponent("/settings")}`;

    // Request.url is always absolute, so it must match the origin-prefixed /api/ branch.
    const first = render(<SessionExpiryRedirect />);
    await window.fetch(new Request(`${ORIGIN}/api/items`));
    expect(assign).toHaveBeenNthCalledWith(1, expected);
    first.unmount();

    // URL inputs go through input.href — also absolute, same branch.
    render(<SessionExpiryRedirect />);
    await window.fetch(new URL("/api/search?q=1", ORIGIN));
    expect(assign).toHaveBeenNthCalledWith(2, expected);
    expect(assign).toHaveBeenCalledTimes(2);
  });

  it("ignores 401s while already on /login so a failed sign-in cannot loop", async () => {
    const { response } = stubFetch(401);
    const assign = stubLocation({ pathname: "/login", search: "?next=%2Fdashboards" });
    render(<SessionExpiryRedirect />);

    await expect(window.fetch("/api/auth/session")).resolves.toBe(response);
    expect(assign).not.toHaveBeenCalled();
  });

  it("passes non-401 responses through without redirecting", async () => {
    const { response } = stubFetch(500);
    const assign = stubLocation();
    render(<SessionExpiryRedirect />);

    await expect(window.fetch("/api/x?a=1")).resolves.toBe(response);
    expect(assign).not.toHaveBeenCalled();
  });

  it("ignores 401s from non-API and cross-origin urls", async () => {
    const { response } = stubFetch(401);
    const assign = stubLocation();
    render(<SessionExpiryRedirect />);

    // Same-origin but outside /api/.
    await expect(window.fetch("/health")).resolves.toBe(response);
    // Absolute url on a different origin, even though its path starts with /api/.
    await expect(window.fetch("https://other.example.com/api/x")).resolves.toBe(response);
    expect(assign).not.toHaveBeenCalled();
  });

  it("restores the original fetch on unmount", async () => {
    const { fetchMock } = stubFetch(401);
    const assign = stubLocation();

    const view = render(<SessionExpiryRedirect />);
    const wrapper = window.fetch;
    expect(wrapper).not.toBe(fetchMock); // mount installed the interceptor

    view.unmount();
    expect(window.fetch).not.toBe(wrapper); // interceptor removed

    // A 401 from /api/ after unmount reaches the network layer but never redirects.
    await window.fetch("/api/x?a=1");
    expect(fetchMock).toHaveBeenCalledWith("/api/x?a=1");
    expect(assign).not.toHaveBeenCalled();
  });
});
