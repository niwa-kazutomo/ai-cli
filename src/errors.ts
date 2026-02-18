export class SigintError extends Error {
  constructor() {
    super("Interrupted");
    this.name = "SigintError";
  }
}
