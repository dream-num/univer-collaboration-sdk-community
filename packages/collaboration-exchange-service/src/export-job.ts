import type { CollabContext, ISnapshotWithBlocks, UnitLoadDataWithBlocks } from "@univerjs-pro/collaboration-service";
import {
  exportSnapshotToBuffer,
  type ExchangeFormat,
  type ExportOptions,
  type IExportOleOptions,
  type IOleOnlineUnitRef,
} from "@univerjs-pro/exchange-node";
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

// unitID: materialize the snapshot and export it; the snapshot is trusted, so files.load fails on a
// reference that is not a file of the exported Unit. jsonID: export the decoded snapshot directly;
// references that fail validation load the placeholder.
// Online attachment versions: exchange-node asks for each referenced child Unit through loadOnlineUnit,
// which reads it with the caller's context (readUnitData runs) and lets files.load release its files.
// The result is written as an HttpExport file of the caller.
export async function runExportJob(job: ExportJob, environment: JobEnvironment): Promise<ExportTaskResult> {
  const { files } = environment;
  const { source } = job;
  const snapshot = source.kind === "unit" ? await environment.units.materialize(source.data) : source.snapshot;
  const unitID = snapshot.snapshot.unitID;
  const children = new Set<string>();
  const loader = exportLoadsFiles(job.type, job.format)
    ? files.exportLoader(unitID, job.context, { trustedHost: source.kind === "unit", children })
    : undefined;
  const ole: IExportOleOptions | undefined = job.options.ole && {
    attachmentSource: "online",
    loadOnlineUnit: async (ref) => {
      const child = await environment.units.materialize(await environment.units.read(ref.unitId, unitTypeOf(ref), job.context));
      children.add(ref.unitId);
      return child;
    },
  };
  const bytes = await exportSnapshotToBuffer(snapshot, {
    ...job.options,
    ...(loader ? { files: loader } : {}),
    ...(ole ? { ole } : {}),
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

// exchange-node names child Units with UniverInstanceType; Doc, Sheet and Slide share UniverType's values.
function unitTypeOf(ref: IOleOnlineUnitRef): UniverType {
  return ref.type as number as UniverType;
}

function unitNameOf(snapshot: ISnapshot): string | undefined {
  return (snapshot.workbook ?? snapshot.doc ?? snapshot.slide ?? snapshot.pdf ?? snapshot.board)?.name;
}
