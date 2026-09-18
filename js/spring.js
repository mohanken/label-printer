// Spring animations, parameterised the way Apple describes them: a damping ratio (1 = settles
// without overshoot, lower = bouncier) and a response time in seconds. Every animation starts
// from the value and velocity currently on screen, so it can be grabbed or retargeted at any
// moment without a jump.

export class Animator {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.springs = new Map();
    this.raf = 0;
    this.last = 0;
    this.instant = false; // set for reduced motion: jump straight to targets
    this.waiters = [];
  }

  spring(key) {
    let s = this.springs.get(key);
    if (!s) {
      s = { value: 0, target: 0, velocity: 0, k: 0, c: 0, eps: 0.01, active: false };
      this.springs.set(key, s);
    }
    return s;
  }

  value(key) {
    return this.spring(key).value;
  }

  target(key) {
    return this.spring(key).target;
  }

  isActive(key) {
    return this.spring(key).active;
  }

  get running() {
    for (const s of this.springs.values()) if (s.active) return true;
    return false;
  }

  // Jump to a value immediately (used while a finger is dragging).
  set(key, value) {
    const s = this.spring(key);
    s.value = s.target = value;
    s.velocity = 0;
    s.active = false;
  }

  to(key, target, { velocity, damping = 1, response = 0.4, eps = 0.01 } = {}) {
    const s = this.spring(key);
    s.target = target;
    if (velocity !== undefined) s.velocity = velocity;
    s.k = ((2 * Math.PI) / response) ** 2;
    s.c = (4 * Math.PI * damping) / response;
    s.eps = eps;
    if (this.instant) {
      s.value = target;
      s.velocity = 0;
      s.active = false;
      this.onFrame();
      this.resolveIfIdle();
      return;
    }
    s.active = true;
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame((t) => this.tick(t));
    }
  }

  // Freeze springs where they are on screen (a finger has grabbed the content).
  stop(keys = [...this.springs.keys()]) {
    for (const key of keys) {
      const s = this.spring(key);
      s.target = s.value;
      s.velocity = 0;
      s.active = false;
    }
    this.resolveIfIdle();
  }

  // Jump springs to where they were heading.
  finish(keys = [...this.springs.keys()]) {
    for (const key of keys) {
      const s = this.spring(key);
      s.value = s.target;
      s.velocity = 0;
      s.active = false;
    }
    this.onFrame();
    this.resolveIfIdle();
  }

  idle() {
    return this.running ? new Promise((resolve) => this.waiters.push(resolve)) : Promise.resolve();
  }

  resolveIfIdle() {
    if (this.running || !this.waiters.length) return;
    const waiters = this.waiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }

  tick(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const steps = Math.max(1, Math.ceil(dt * 240));
    const h = dt / steps;
    let any = false;
    for (const s of this.springs.values()) {
      if (!s.active) continue;
      for (let i = 0; i < steps; i++) {
        const a = -s.k * (s.value - s.target) - s.c * s.velocity;
        s.velocity += a * h;
        s.value += s.velocity * h;
      }
      if (Math.abs(s.value - s.target) < s.eps && Math.abs(s.velocity) < s.eps * 10) {
        s.value = s.target;
        s.velocity = 0;
        s.active = false;
      } else {
        any = true;
      }
    }
    this.onFrame();
    this.raf = any ? requestAnimationFrame((t) => this.tick(t)) : 0;
    if (!any) this.resolveIfIdle();
  }
}
