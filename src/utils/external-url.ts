/** Accept absolute web links, including legacy values wrapped in matching quotes. */
export function normalizeExternalUrl(value: string | null | undefined): string | null {
  let input = value?.trim() ?? '';
  if (input.length >= 2 && ((input[0] === '"' && input.at(-1) === '"') || (input[0] === "'" && input.at(-1) === "'"))) {
    input = input.slice(1, -1).trim();
  }
  try {
    const parsed = new URL(input);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Do not send the application's own pages to the system browser. */
export function externalNavigationUrl(value: string, appOrigin: string): string | null {
  const url = normalizeExternalUrl(value);
  return url && new URL(url).origin !== appOrigin ? url : null;
}
