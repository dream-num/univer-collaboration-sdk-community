import type { CollabContext, ISnapshotWithBlocks, UnitLoadDataWithBlocks } from "@univerjs-pro/collaboration-service";
import { exportSnapshotToBuffer, type ExchangeFormat, type ExportOptions } from "@univerjs-pro/exchange-node";
import type { ISnapshot, UniverType } from "@univerjs/protocol";
import { exportContentType, exportFileName } from "./formats.js";
import { assertRunning, type JobEnvironment } from "./job-environment.js";
import { exportLoadsFiles, type ConversionOptions } from "./options.js";
import type { ExportTaskResult } from "./types.js";

/** The export input the request phase already read: Unit load data, or the decoded upload. */
export type ExportSource =
  | { readonly kind: "unit"; readonly unitID: string; readonly data: UnitLoadDataWithBlocks }
  | { readonly kind: "json"; readonly jsonID: string; readonly snapshot: ISnapshotWithBlocks };

export interface ExportJob {
  readonly context: CollabContext;
  readonly type: UniverType;
  readonly format: ExchangeFormat;
  readonly source: ExportSource;
  readonly options: ConversionOptions;
}

// unitID: materialize the snapshot and export it; files.load only releases files of the exported Unit.
// jsonID: export the decoded snapshot directly; references that fail validation load the placeholder.
// The result is written as an HttpExport file of the caller.
export async function runExportJob(job: ExportJob, environment: JobEnvironment): Promise<ExportTaskResult> {
  const { files } = environment;
  const { source } = job;
  const snapshot = source.kind === "unit" ? await environment.units.materialize(source.data) : source.snapshot;
  const unitID = snapshot.snapshot.unitID;
  const loader = !exportLoadsFiles(job.type, job.format)
    ? undefined
    : source.kind === "unit"
      ? files.unitLoader(source.unitID, job.context)
      : files.snapshotLoader(unitID, job.context);
  const bytes = await exportSnapshotToBuffer(snapshot, {
    ...job.options,
    ...(loader ? { files: loader } : {}),
  } as ExportOptions);
  assertRunning(environment);
  const fileID = await files.saveResult(
    {
      name: exportFileName(unitNameOf(snapshot.snapshot), unitID, job.format),
      contentType: exportContentType(job.format),
      bytes,
    },
    job.context
  );
  return { fileID };
}

function unitNameOf(snapshot: ISnapshot): string | undefined {
  return (snapshot.workbook ?? snapshot.doc ?? snapshot.slide ?? snapshot.pdf ?? snapshot.board)?.name;
}
