export class Permission {
  constructor(autoApprove = true) {
    this._autoApprove = autoApprove;
    this._rules = [];
  }

  addRule(pattern, action) { this._rules.push({ pattern, action }); }

  async check(_tool, _args) {
    if (this._autoApprove) return { allowed: true };
    // Check rules implementation
    return { allowed: this._rules.length > 0 ? false : true };
  }
}
