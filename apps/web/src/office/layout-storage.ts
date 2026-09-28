/**
 * Where the canvas remembers what you moved.
 *
 * The office file says which departments exist; this says where you put them.
 * They are kept apart on purpose: reopening an office should not undo an
 * afternoon of arranging, and rearranging should not rewrite the office's
 * definition. When the API lands, layout moves server-side and this goes away —
 * which is why it is a port with one small shape rather than calls to
 * localStorage scattered through the store.
 */
export interface DepartmentLayout {
  readonly position: { readonly x: number; readonly y: number };
  readonly size: { readonly width: number; readonly height: number };
}

export interface StoredLayout {
  readonly departments: Readonly<Record<string, DepartmentLayout>>;
  readonly snapToGrid: boolean;
}

export interface LayoutStorage {
  readLayout(): StoredLayout | null;
  writeLayout(layout: StoredLayout): void;
}

export const LAYOUT_STORAGE_KEY = "vo.canvas.layout";

function isLayout(value: unknown): value is StoredLayout {
  if (typeof value !== "object" || value === null) return false;
  // Read it as unknown rather than asserting the shape: the point of this
  // function is that whatever came out of storage might be anything at all.
  const departments = (value as Record<string, unknown>)["departments"];
  return typeof departments === "object" && departments !== null;
}

/** Layout in the browser. A blocked or corrupt store is treated as "no layout". */
export function browserLayoutStorage(key = LAYOUT_STORAGE_KEY): LayoutStorage {
  return {
    readLayout: () => {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) return null;
        const parsed: unknown = JSON.parse(raw);
        return isLayout(parsed) ? parsed : null;
      } catch {
        // A half-written or unreadable layout is not worth failing the app over.
        return null;
      }
    },
    writeLayout: (layout) => {
      try {
        localStorage.setItem(key, JSON.stringify(layout));
      } catch {
        // The canvas still works for this session; it just forgets afterwards.
      }
    },
  };
}
