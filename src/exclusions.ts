function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findExcludedTerm(text: string, excludedTerms: string[]): string | undefined {
  for (const rawTerm of excludedTerms) {
    const term = rawTerm.trim();
    if (!term) continue;

    const startsWithWordCharacter = /^[\p{L}\p{N}_]/u.test(term);
    const endsWithWordCharacter = /[\p{L}\p{N}_]$/u.test(term);
    // biome-ignore lint/security/noSecrets: Regex word boundary pattern
    const leftBoundary = startsWithWordCharacter ? '(?<![\\p{L}\\p{N}_])' : '';
    // biome-ignore lint/security/noSecrets: Regex word boundary pattern
    const rightBoundary = endsWithWordCharacter ? '(?![\\p{L}\\p{N}_])' : '';
    const pattern = new RegExp(`${leftBoundary}${escapeRegExp(term)}${rightBoundary}`, 'iu');
    if (pattern.test(text)) return term;
  }
  return undefined;
}
