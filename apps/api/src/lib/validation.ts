import type { ZodError } from "zod";

export interface ValidationErrorBody {
  message: string;
  issues: { path: string; message: string }[];
}

/**
 * Turn a ZodError into a safe, client-facing summary (field path + message).
 * Never echoes raw internals or the offending values.
 */
export function formatZodError(error: ZodError): ValidationErrorBody {
  return {
    message: "Invalid request body",
    issues: error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    })),
  };
}
