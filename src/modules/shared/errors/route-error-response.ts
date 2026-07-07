import "server-only";

import { NextResponse } from "next/server";

import { toFriendlyErrorResponse, type FriendlyErrorOptions } from "./error-response";

export function routeErrorResponse(error: unknown, options: FriendlyErrorOptions = {}) {
  const { body, status } = toFriendlyErrorResponse(error, options);
  return NextResponse.json(body, { status });
}
