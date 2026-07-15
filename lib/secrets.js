const SECRET_PATTERNS = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/gi,
  /\b(?:api[_ -]?key|token|password|credential)\s*(?:[:=]|\s+)\s*[^\s"']+/gi,
];

export function redactSecrets(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, match => {
    const prefix = /^(?:Bearer\s+|(?:api[_ -]?key|token|password|credential)\s*[:=]\s*)/i.exec(match)?.[0] || "";
    return `${prefix}[REDACTED]`;
  });
  return text;
}

export function extractCredential(value) {
  const text = String(value ?? "");
  const known = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,})\b/i.exec(text)?.[0];
  if (known) return known;
  const labeled = /\b(?:token|credential|password)\b\s*(?:ini|is|nya)?\s*[:=]?\s*([^\s"']{12,})/i.exec(text)?.[1];
  return labeled || null;
}
