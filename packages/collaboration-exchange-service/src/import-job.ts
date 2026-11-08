import { randomUUID } from "node:crypto";
import type { CollabContext } from "@univerjs-pro/collaboration-service";
import { importBufferToSnapshot, type BufferImportOptions } from "@univerjs-pro/exchange-node";
import type { UniverType } from "@univerjs/protocol";
import { assertRunning, type JobEnvironment } from "./job-environment.js";
import { importStoresFiles, type ConversionOptions } from "./options.js";
import { encodeSnapshotJson } from "./snapshot-json.js";
import { IMPORT_OUTPUT_TYPE } from "./import-output-type.js";
import type { ImportOutputType, ImportTaskResult } from "./types.js";

// The collaboration Service requires a new Unit to start at revision 1.
const INITIAL_REVISION = 1;

/**
 * The import input the request phase already checked: the caller's upload, which is deleted when the
 * task ends, or a stored attachment of `unitID`, which stays with that Unit.
 */
export type ImportSource =
  | { readonly kind: "upload"; readonly fileID: string }
  | { readonly kind: "attachment"; readonly fileID: string; readonly unitID: string };

/** Everything the request phase resolved for one import; the job only converts and stores. */
export interface ImportJob {
  readonly context: CollabContext;
  readonly type: UniverType;
  readonly outputType: ImportOutputType;
  readonly source: ImportSource;
  readonly fileName: string;
  readonly options: ConversionOptions;
}

// UNIT: generate the unitID first, store images and attachments through files.store as UnitEmbedded
// files of that Unit, then createUnit; any failure after files were written deletes them. JSON: no
// files, the snapshot stays inline and the result is written as HttpExport JSON.
export async function runImportJob(job: ImportJob, environment: JobEnvironment): Promise<ImportTaskResult> {
  const { files } = environment;
  const bytes = await files.read(job.source.fileID, job.context);
  if (job.outputType === IMPORT_OUTPUT_TYPE.Json) {
    const snapshot = await importBufferToSnapshot(bytes, { ...job.options, fileName: job.fileName } as BufferImportOptions);
    assertRunning(environment);
    const jsonID = await files.saveResult(
      { name: jsonFileName(job.fileName), contentType: "application/json", bytes: encodeSnapshotJson(snapshot) },
      job.context
    );
    return { outputType: IMPORT_OUTPUT_TYPE.Json, jsonID };
  }

  const unitID = randomUUID();
  const sink = importStoresFiles(job.type) ? files.createUnitFileSink(unitID, job.context) : undefined;
  try {
    const imported = await importBufferToSnapshot(bytes, {
      ...job.options,
      fileName: job.fileName,
      unitId: unitID,
      ...(sink ? { files: { store: sink.store } } : {}),
    } as BufferImportOptions);
    assertRunning(environment);
    await environment.units.create(
      { snapshot: { ...imported.snapshot, unitID, type: job.type, rev: INITIAL_REVISION }, sheetBlocks: imported.sheetBlocks },
      job.context
    );
    return { outputType: IMPORT_OUTPUT_TYPE.Unit, unitID };
  } catch (error) {
    await sink?.discard();
    throw error;
  }
}

function jsonFileName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return `${dot > 0 ? fileName.slice(0, dot) : fileName}.json`;
}
