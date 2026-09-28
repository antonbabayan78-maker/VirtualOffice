/**
 * React Flow measures the DOM, and jsdom has no layout. These are the shims its
 * own testing guidance calls for: without them every node reports a zero size
 * and nothing renders. Imported by canvas tests only, so the rest of the suite
 * keeps an honest DOM.
 */
class TestResizeObserver {
  // Nothing to observe: jsdom never resizes anything.
  observe(): void {
    // intentionally empty
  }
  unobserve(): void {
    // intentionally empty
  }
  disconnect(): void {
    // intentionally empty
  }
}

class TestDOMMatrixReadOnly {
  readonly m22 = 1;
}

export function installCanvasTestEnv(): void {
  // Assigned outright: the DOM types insist these exist, while jsdom has neither.
  globalThis.ResizeObserver = TestResizeObserver;
  (globalThis as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = TestDOMMatrixReadOnly;

  for (const property of ["offsetWidth", "offsetHeight"] as const) {
    Object.defineProperty(HTMLElement.prototype, property, {
      configurable: true,
      value: property === "offsetWidth" ? 800 : 600,
    });
  }
  (SVGElement.prototype as unknown as { getBBox?: () => DOMRect }).getBBox ??= () =>
    ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
}
