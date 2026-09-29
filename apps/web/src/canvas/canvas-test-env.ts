/**
 * Things jsdom does not have that a browser does.
 *
 * React Flow measures the DOM and jsdom has no layout, so without these shims
 * every node reports a zero size and nothing renders — they are the ones React
 * Flow's own testing guidance calls for. `Blob.arrayBuffer` is here for the same
 * reason: every browser has had it for years, jsdom has never implemented it,
 * and reading a dropped file is not worth writing against the older FileReader
 * to suit a test environment. `URL.createObjectURL` is the same story on the way
 * back out, for handing a document to the browser to save.
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

  const url = URL as unknown as {
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
  };
  url.createObjectURL ??= () => "blob:test";
  url.revokeObjectURL ??= () => undefined;

  const blob = Blob.prototype as unknown as { arrayBuffer?: () => Promise<ArrayBuffer> };
  blob.arrayBuffer ??= function readAsArrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve(reader.result as ArrayBuffer);
      };
      reader.onerror = () => {
        reject(reader.error ?? new Error("could not read the blob"));
      };
      reader.readAsArrayBuffer(this);
    });
  };
}
