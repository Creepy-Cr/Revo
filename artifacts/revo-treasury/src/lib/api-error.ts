type ApiErrorData = {
  error?: string;
  code?: string;
};

function apiErrorData(error: unknown): ApiErrorData | undefined {
  return (error as { data?: ApiErrorData } | null | undefined)?.data;
}

export function apiErrorCode(error: unknown): string | undefined {
  return apiErrorData(error)?.code;
}

export function apiErrorMessage(error: unknown, fallback: string = 'An error occurred'): string {
  const data = apiErrorData(error);
  if (data?.code === 'stale_session') {
    return 'This sensitive action requires a fresh wallet signature. Sign in again and retry.';
  }
  return typeof data?.error === "string" && data.error.length > 0 ? data.error : fallback;
}
