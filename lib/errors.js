export class KhazaiAiError extends Error {
  constructor(msg) { super(msg); this.name = "KhazaiAiError"; }
}
export class TokenLimitError extends KhazaiAiError {
  constructor(msg) { super(msg); this.name = "TokenLimitError"; }
}
export class AuthError extends KhazaiAiError {
  constructor(msg) { super(msg); this.name = "AuthError"; }
}
