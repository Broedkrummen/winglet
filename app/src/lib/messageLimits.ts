/** Match Python's Unicode character count, including characters outside the BMP. */
export const MAX_MESSAGE_CHARACTERS = 16_000;

export function messageLimitError(text: string): string | undefined {
  return Array.from(text.trim()).length > MAX_MESSAGE_CHARACTERS
    ? 'Messages can contain at most 16,000 characters. Shorten it or attach a file.' : undefined;
}
