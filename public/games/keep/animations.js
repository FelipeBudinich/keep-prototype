// Presentation-only effects never mutate the authoritative view or wait to enable play.
export class Presentation {
  constructor() {
    this.version = null;
    this.changedAt = 0;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  observe(view) {
    if (view?.stateVersion !== this.version) {
      this.version = view?.stateVersion;
      this.changedAt = performance.now();
    }
  }
  glow() {
    return this.reduced
      ? 0
      : Math.max(0, 1 - (performance.now() - this.changedAt) / 700);
  }
}
