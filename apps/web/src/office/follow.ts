/**
 * Keeping the canvas in step with the office.
 *
 * An event says what changed and where, not what it now is, so the canvas
 * fetches that one entity rather than reloading everything. A busy office
 * therefore costs one small request per change instead of a full reload per
 * change.
 *
 * Every event moves the client's offset forward, including one that could not
 * be fetched. Waiting for a fetch to succeed before moving on would leave a
 * canvas asking about the same event for as long as the office is unreachable,
 * and the next reconnect repairs it anyway.
 */
import type { Department, DocumentId, Employee, EmployeeId, OfficeId } from "@vo/core";
import type { ApiClient } from "@vo/api-client";
import type { OfficeStore } from "./office-store.js";

export interface OfficeStreamEvent {
  readonly offset: number;
  readonly officeId: string;
  readonly at: number;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface FollowOptions {
  readonly store: OfficeStore;
  readonly api: ApiClient;
  readonly officeId: string;
}

export interface OfficeFollower {
  /** Brings the canvas in line with one event. */
  apply(event: OfficeStreamEvent): Promise<void>;
  /** Loads the whole office again, for when following is no longer possible. */
  reload(): Promise<void>;
}

export function followOffice({ store, api, officeId }: FollowOptions): OfficeFollower {
  const replaceDepartment = (department: Department): void => {
    const departments = store.getState().departments;
    const known = departments.some((candidate) => candidate.id === department.id);
    store.setState({
      departments: known
        ? departments.map((candidate) => (candidate.id === department.id ? department : candidate))
        : [...departments, department],
    });
  };

  const replaceEmployee = (employee: Employee): void => {
    const employees = store.getState().employees;
    const known = employees.some((candidate) => candidate.id === employee.id);
    store.setState({
      employees: known
        ? employees.map((candidate) => (candidate.id === employee.id ? employee : candidate))
        : [...employees, employee],
    });
  };

  const apply = async (event: OfficeStreamEvent): Promise<void> => {
    // Read, not coerced: an event carrying an object where a name belongs is
    // not something to turn into the text "[object Object]" and act on.
    const kind = typeof event.data["kind"] === "string" ? event.data["kind"] : "";
    const id = typeof event.data["id"] === "string" ? event.data["id"] : "";

    try {
      if (kind === "department.deleted") {
        store.setState({
          departments: store.getState().departments.filter((candidate) => candidate.id !== id),
        });
      } else if (kind === "department.created" || kind === "department.updated") {
        const fetched = await api.getDepartment(id);
        if (fetched.ok) replaceDepartment(fetched.value);
      } else if (kind === "task.created" || kind === "task.updated") {
        // A task moving is what makes the office look busy, so this is the
        // event that changes what the figures on the canvas are doing.
        const fetched = await api.getTask(id);
        if (fetched.ok) store.getState().putTask(fetched.value);
      } else if (kind === "employee.created" || kind === "employee.updated") {
        const fetched = await api.getEmployee(id);
        if (fetched.ok) replaceEmployee(fetched.value);
      } else if (
        kind === "connection.created" ||
        kind === "connection.updated" ||
        kind === "connection.deleted"
      ) {
        // An arrow has no route of its own to fetch, so the office is asked
        // again. There are a handful of them and this is a rare event.
        const snapshot = await api.loadOffice(officeId);
        if (snapshot.ok) {
          store.setState({ connections: snapshot.value.connections });
          store
            .getState()
            .load(
              store.getState().departments,
              store.getState().employees,
              store.getState().tasks,
              snapshot.value.connections,
            );
        }
      } else if (
        kind === "connector.created" ||
        kind === "connector.updated" ||
        kind === "connector.deleted"
      ) {
        // Re-listed rather than fetched one at a time, as arrows are: there are
        // a handful of them, this is a rare event, and a deletion has nothing to
        // fetch. Only the connectors are replaced, so a connector switched off
        // does not cost the canvas its departments.
        const listed = await api.listConnectors(officeId);
        if (listed.ok) store.getState().loadConnectors(listed.value);
      } else if (kind === "document.added") {
        const fetched = await api.getDocument(id);
        if (fetched.ok) store.getState().putDocument(fetched.value);
      } else if (kind === "document.removed") {
        // Nothing to fetch: it has gone, and asking would only be a 404.
        store.getState().dropDocument(id as DocumentId);
      } else if (kind === "office.updated") {
        const fetched = await api.getOffice(id);
        if (fetched.ok) store.getState().loadOffice(fetched.value);
      }
    } finally {
      // Moves on either way: a failed fetch is repaired by the next reconnect,
      // and standing still would mean asking about this event forever.
      store.getState().setSeenOffset(event.offset);
    }
  };

  const reload = async (): Promise<void> => {
    const snapshot = await api.loadOffice(officeId);
    if (!snapshot.ok) {
      store
        .getState()
        .setNotice(snapshot.kind === "transport" ? snapshot.message : "could not load this office");
      return;
    }
    store.getState().loadOffice(snapshot.value.office);
    store
      .getState()
      .load(
        snapshot.value.departments,
        snapshot.value.employees,
        snapshot.value.tasks,
        snapshot.value.connections,
      );

    store.getState().loadConnectors(snapshot.value.connectors);

    // Every tray in one request, since a tray is a filter over these. An office
    // that cannot answer is an office with no trays rather than one that fails
    // to open, so a refusal is not reported as a problem with the office.
    const documents = await api.listDocuments(officeId);
    if (documents.ok) store.getState().loadDocuments(documents.value);
  };

  return { apply, reload };
}

export type { OfficeId, EmployeeId };
