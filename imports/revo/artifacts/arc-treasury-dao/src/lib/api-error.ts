export function apiErrorMessage(error: unknown, fallback: string = 'An error occurred'): string {
  const data = (error as { data?: { error?: string, code?: string } } | null | undefined)?.data;
  if (data?.code === 'stale_session') {
    return 'Your session has expired. Please sign in again to perform this action.';
  }
  return typeof data?.error === "string" && data.error.length > 0 ? data.error : fallback;
}
