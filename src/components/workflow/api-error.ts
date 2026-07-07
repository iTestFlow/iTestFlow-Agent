import {
  AppErrorCode,
  isAppErrorCode,
  type ErrorTechnicalContext,
} from "@/modules/shared/errors/app-error";
import { apiErrorMessage } from "@/shared/lib/api-error-message";

export type ApiErrorPayload = {
  error?: unknown;
  code?: unknown;
  technicalDetails?: unknown;
  technicalContext?: unknown;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code?: AppErrorCode;
  readonly technicalDetails?: string;
  readonly technicalContext?: ErrorTechnicalContext;

  constructor(message: string, options: {
    status: number;
    code?: AppErrorCode;
    technicalDetails?: string;
    technicalContext?: ErrorTechnicalContext;
  }) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.technicalDetails = options.technicalDetails;
    this.technicalContext = options.technicalContext;
  }

  static fromResponse(payload: ApiErrorPayload, status: number) {
    const message = apiErrorMessage(payload, `Request failed: ${status}`);
    return new ApiError(message, {
      status,
      code: isAppErrorCode(payload.code) ? payload.code : undefined,
      technicalDetails: typeof payload.technicalDetails === "string" ? payload.technicalDetails : undefined,
      technicalContext: isTechnicalContext(payload.technicalContext) ? payload.technicalContext : undefined,
    });
  }
}

function isTechnicalContext(value: unknown): value is ErrorTechnicalContext {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
