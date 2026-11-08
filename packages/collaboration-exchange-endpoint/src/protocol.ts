import {
  ExchangeServiceError,
  IMPORT_OUTPUT_TYPE,
  type ExchangeTask,
  type ExportInput,
  type ImportInput,
} from "@univerjs-pro/collaboration-exchange-service";
import type { IError } from "@univerjs/protocol";
import { OK_ERROR } from "./protocol-errors.js";

// HTTP messages to and from Service inputs and outputs. Only the structure is converted here: the
// numeric type in the path and the JSON body fields. The Service validates the values, so the rules
// live in one place.

type Body = Readonly<Record<string, unknown>>;

/** `{type}` path segment → `UniverType` number. */
export function parseRouteType(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw invalid("Route type must be a UniverType number");
  return Number(value);
}

/** Import body `{ fileID, outputType, sourceUnitID?, options? }`. */
export function parseImportBody(type: number, body: unknown): ImportInput {
  const fields = requireBody(body);
  return {
    type,
    fileID: fields.fileID as string,
    outputType: fields.outputType as ImportInput["outputType"],
    ...present("sourceUnitID", fields.sourceUnitID as string | undefined),
    ...present("options", fields.options as ImportInput["options"]),
  };
}

/** Export body `{ unitID?, jsonID?, type, format, options? }`; the route type wins over the body type. */
export function parseExportBody(type: number, body: unknown): ExportInput {
  const fields = requireBody(body);
  return {
    type,
    format: fields.format as string,
    ...present("unitID", fields.unitID as string | undefined),
    ...present("jsonID", fields.jsonID as string | undefined),
    ...present("options", fields.options as ExportInput["options"]),
  };
}

/**
 * GetTask response body. A failed task answers with its non-OK code and `status: "failed"`; the
 * client only accepts `pending` or `done` together with OK.
 */
export function taskResponseBody(task: ExchangeTask, failure: (error: unknown) => IError): object {
  switch (task.status) {
    case "pending":
      return { error: OK_ERROR, taskID: task.taskID, status: "pending" };
    case "failed":
      return { error: failure(task.error), taskID: task.taskID, status: "failed" };
    case "done":
      if (task.kind === "import") {
        const { result } = task;
        return {
          error: OK_ERROR,
          taskID: task.taskID,
          status: "done",
          import: {
            outputType: result.outputType,
            unitID: result.outputType === IMPORT_OUTPUT_TYPE.Unit ? result.unitID : "",
            jsonID: result.outputType === IMPORT_OUTPUT_TYPE.Json ? result.jsonID : "",
          },
        };
      }
      // The frontend resolves the download URL from fileID through sign-url and ignores fileUrl.
      return { error: OK_ERROR, taskID: task.taskID, status: "done", export: { fileID: task.result.fileID, fileUrl: "" } };
  }
}

function requireBody(body: unknown): Body {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("Request body must be a JSON object");
  return body as Body;
}

// exactOptionalPropertyTypes: a missing field is omitted rather than set to undefined.
function present<K extends string, V>(key: K, value: V | undefined | null): { [P in K]?: V } {
  return value === undefined || value === null ? {} : ({ [key]: value } as { [P in K]?: V });
}

function invalid(message: string): ExchangeServiceError {
  return new ExchangeServiceError("INVALID_REQUEST", message);
}
