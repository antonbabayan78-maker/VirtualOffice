/**
 * The palette: what you can put in the office.
 *
 * Drag an item onto the canvas, or — since a drag is impossible with a keyboard
 * and awkward with a screen reader — press it. Pressing adds the same thing in
 * the same way, into the selected department for a person, and clear of
 * everything else for a department.
 */
import type { DragEvent, ReactNode } from "react";
import { cn } from "../ui/cn.js";
import type { OfficeStore } from "../office/office-store.js";
import { EmployeeAvatar } from "./EmployeeAvatar.js";
import { PALETTE_ITEMS, dropItem, type PaletteItem, type PaletteKind } from "./drop.js";

/** How a dragged palette item identifies itself to the canvas. */
export const PALETTE_MIME = "application/vo-palette-item";

function Glyph({ kind }: { readonly kind: PaletteKind }): ReactNode {
  if (kind === "person") return <EmployeeAvatar name="A new person" state="idle" size={28} />;
  return (
    <span
      aria-hidden
      className="block h-5 w-8 rounded border-2 border-ink-muted bg-surface-muted"
    />
  );
}

/** Somewhere clear of every department, so a new one does not land on an old one. */
function freeSpace(store: OfficeStore): { x: number; y: number } {
  const departments = store.getState().departments;
  if (departments.length === 0) return { x: 40, y: 40 };
  const lowest = Math.max(...departments.map((d) => d.position.y + d.size.height));
  return { x: 40, y: lowest + 60 };
}

function addByKeyboard(store: OfficeStore, kind: PaletteKind): void {
  if (kind === "department") {
    dropItem(store, "department", freeSpace(store));
    return;
  }

  const selectedId = store.getState().selectedId;
  if (selectedId === null) {
    store.getState().setNotice("Select a department first, then add a person to it.");
    return;
  }
  const department = store.getState().departments.find((candidate) => candidate.id === selectedId);
  if (department === undefined) return;
  // Aim at the middle of the room, which is inside it by definition.
  dropItem(store, "person", {
    x: department.position.x + department.size.width / 2,
    y: department.position.y + department.size.height / 2,
  });
}

export function Palette({ store }: { readonly store: OfficeStore }): ReactNode {
  const onDragStart = (event: DragEvent<HTMLButtonElement>, item: PaletteItem): void => {
    event.dataTransfer.setData(PALETTE_MIME, item.kind);
    event.dataTransfer.effectAllowed = "copy";
  };

  return (
    <aside
      aria-label="Palette"
      className="flex w-40 shrink-0 flex-col gap-2 border-r border-border bg-surface p-3"
    >
      <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Add</h2>
      {PALETTE_ITEMS.map((item) => (
        <button
          key={item.kind}
          type="button"
          draggable
          aria-describedby={`palette-hint-${item.kind}`}
          onDragStart={(event) => {
            onDragStart(event, item);
          }}
          onClick={() => {
            addByKeyboard(store, item.kind);
          }}
          className={cn(
            "flex cursor-grab items-center gap-3 rounded-panel border border-border bg-surface px-3 py-2",
            "text-left text-sm text-ink hover:bg-surface-muted active:cursor-grabbing",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          )}
        >
          <Glyph kind={item.kind} />
          <span>{item.label}</span>
        </button>
      ))}

      {PALETTE_ITEMS.map((item) => (
        <p key={item.kind} id={`palette-hint-${item.kind}`} className="sr-only">
          {item.hint}
        </p>
      ))}

      <p className="mt-auto text-[11px] leading-snug text-ink-muted">
        Drag onto the canvas, or select a department and press an item.
      </p>
    </aside>
  );
}
