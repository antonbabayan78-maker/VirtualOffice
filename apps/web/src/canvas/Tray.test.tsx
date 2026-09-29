import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDocument, unwrap, type Document, type DocumentId, type OfficeId } from "@vo/core";
import { createOfficeStore, type OfficeStore } from "../office/office-store.js";
import { Tray } from "./Tray.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-09-29T09:00:00Z");

const doc = (id: string, overrides: Partial<Document> = {}): Document => ({
  ...unwrap(
    createDocument(
      {
        officeId,
        owner: { kind: "employee", id: "emp-ada" },
        tray: "in",
        name: `${id}.md`,
        mediaType: "text/markdown",
        size: 2048,
      },
      { id: () => id as DocumentId, now: () => at },
    ),
  ),
  ...overrides,
});

let store: OfficeStore;

const mount = (tray: "in" | "out" = "in") =>
  render(<Tray store={store} owner={{ kind: "employee", id: "emp-ada" }} tray={tray} />);

const tray = (name: RegExp) => screen.getByRole("group", { name });

beforeEach(() => {
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "new",
    now: () => at,
    officeId,
  });
});

describe("a tray on somebody's desk", () => {
  it("says what it is", () => {
    mount("in");
    expect(tray(/in-tray/i)).toBeInTheDocument();
  });

  it("says when there is nothing in it, rather than showing an empty box", () => {
    mount();
    expect(tray(/in-tray/i)).toHaveTextContent(/empty/i);
  });

  it("lists what its owner was given", () => {
    store.getState().loadDocuments([doc("one"), doc("two")]);
    mount();

    const items = within(tray(/in-tray/i)).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("one.md"),
      expect.stringContaining("two.md"),
    ]);
  });

  it("does not show the other tray's documents", () => {
    store.getState().loadDocuments([doc("given"), doc("made", { tray: "out" })]);
    mount("in");

    expect(tray(/in-tray/i)).toHaveTextContent("given.md");
    expect(tray(/in-tray/i)).not.toHaveTextContent("made.md");
  });

  it("does not show somebody else's documents", () => {
    store.getState().loadDocuments([doc("mine"), doc("theirs", { ownerId: "emp-theo" })]);
    mount();

    expect(tray(/in-tray/i)).not.toHaveTextContent("theirs.md");
  });

  it("does not mistake a task for an employee with the same id", () => {
    store.getState().loadDocuments([doc("task", { ownerKind: "task" })]);
    mount();
    expect(tray(/in-tray/i)).toHaveTextContent(/empty/i);
  });

  it("says how big each document is, in a size a person reads", () => {
    store.getState().loadDocuments([doc("one")]);
    mount();
    expect(tray(/in-tray/i)).toHaveTextContent("2 KB");
  });
});

describe("putting something in a tray", () => {
  const pick = async (file: File) => {
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText(/add a document/i), file);
  };

  it("sends a chosen file to the office, with its name and kind", async () => {
    const filed = vi.fn().mockResolvedValue({ ok: true });
    store.setState({ fileDocument: filed } as never);
    mount();

    await pick(new File(["# Brief\n"], "brief.md", { type: "text/markdown" }));

    // Reading the file is asynchronous, which is the point: this is the one
    // thing on the canvas that has to wait for something.
    await vi.waitFor(() => {
      expect(filed).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: { kind: "employee", id: "emp-ada" },
          tray: "in",
          name: "brief.md",
          mediaType: "text/markdown",
        }),
      );
    });
  });

  it("sends the bytes of the file, not a description of it", async () => {
    let sent: Uint8Array | undefined;
    store.setState({
      fileDocument: (input: { body: Uint8Array }) => {
        sent = input.body;
        return Promise.resolve({ ok: true });
      },
    } as never);
    mount();

    await pick(new File(["hello"], "note.txt", { type: "text/plain" }));
    await vi.waitFor(() => {
      expect(new TextDecoder().decode(sent)).toBe("hello");
    });
  });

  it("puts a file dropped on it in the same tray", async () => {
    const filed = vi.fn().mockResolvedValue({ ok: true });
    store.setState({ fileDocument: filed } as never);
    mount("out");

    // A drop is the gesture this is for; the file input is the way in for
    // anybody not using a mouse.
    const file = new File(["x"], "dropped.md", { type: "text/markdown" });
    fireEvent.drop(tray(/out-tray/i), { dataTransfer: { files: [file], types: ["Files"] } });

    await vi.waitFor(() => {
      expect(filed).toHaveBeenCalled();
    });
    expect(filed.mock.calls[0]?.[0]).toMatchObject({ name: "dropped.md", tray: "out" });
  });

  it("says what the office refused", async () => {
    store.setState({
      fileDocument: () =>
        Promise.resolve({
          ok: false,
          problems: [{ path: "name", message: "must be a file name, not a path" }],
        }),
    } as never);
    mount();

    await pick(new File(["x"], "bad.md", { type: "text/markdown" }));
    await vi.waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/must be a file name/i);
    });
  });

  it("says it is working while the document is on its way", () => {
    // The only wait on this canvas worth showing: bytes have to travel.
    store.setState({ uploading: true });
    mount();
    expect(tray(/in-tray/i)).toHaveTextContent(/sending/i);
  });
});

describe("taking something out of a tray", () => {
  beforeEach(() => {
    store.getState().loadDocuments([doc("one")]);
  });

  it("asks the office to take it off the desk", async () => {
    const taken = vi.fn().mockResolvedValue({ ok: true });
    store.setState({ takeDocument: taken } as never);
    mount();

    await userEvent.setup().click(screen.getByRole("button", { name: "Remove one.md" }));
    expect(taken).toHaveBeenCalledWith("one");
  });

  it("offers the document itself, which only the store can fetch", async () => {
    const fetched = vi.fn().mockResolvedValue(new TextEncoder().encode("# One\n"));
    store.setState({ fetchBody: fetched } as never);
    // What the browser is handed, rather than a link the office would want a
    // token on.
    const offered: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      offered.push(this.download);
    });
    mount();

    await userEvent.setup().click(screen.getByRole("button", { name: "Download one.md" }));
    expect(fetched).toHaveBeenCalledWith("one");
    await vi.waitFor(() => {
      expect(offered).toEqual(["one.md"]);
    });
  });
});
