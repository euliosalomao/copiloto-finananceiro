export function normalizeDescription(
  description: string,
): string {
  return description
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchesMerchantRule(
  description: string,
  pattern: string,
  matchType: string,
): boolean {
  const normalizedDescription = normalizeDescription(description);

  const normalizedPattern = pattern
    .trim()
    .toUpperCase();

  if (!normalizedPattern) {
    return false;
  }

  switch (matchType) {
    case "EXACT":
      return normalizedDescription === normalizedPattern;

    case "CONTAINS":
      return normalizedDescription.includes(normalizedPattern);

    default:
      return false;
  }
}