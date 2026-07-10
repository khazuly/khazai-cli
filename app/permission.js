export class Permission {
  constructor(autoApprove = true) {
    this._autoApprove = autoApprove;
    this._rules = [];
  }
  addRule(pattern, action) { this._rules.push({ pattern, action }); }
  async check(_tool, _args) {
    if (this._autoApprove) return { allowed: true };
    return { allowed: true };
  }
}
