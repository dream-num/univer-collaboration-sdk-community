import { Buffer } from "node:buffer";
import type { FileCallContext, FileContent, FileRecord, IUniverFileService } from "@univerjs-pro/collaboration-file-service";
import type { ILogger } from "@univerjs-pro/collaboration-service";
import type { IExportFileRef, IExportFilesOptions, IImportFilesOptions } from "@univerjs-pro/exchange-node";
import { FileSource } from "@univerjs/protocol";
import { fileNotFound } from "./errors.js";

// Every interaction between Exchange and File lives here. Only the trusted layer of the File Service is
// called (no File middleware), ownership is checked by this class, and every call uses the caller's context.

// A 1x1 transparent PNG. URL images and references of a jsonID snapshot that fail validation load it on
// export: exchange-node requires files.load to return bytes for every reference, so the image shows
// blank, while a stored attachment fails exchange-node's SHA-256 check.
const TRANSPARENT_PNG = new Uint8Array(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64")
);

/** Collects the files one Unit import stores, so a failed import can remove them all. */
export interface UnitFileSink {
  readonly store: IImportFilesOptions["store"];
  /** Deletes every file stored so far; failures are logged, not thrown. */
  discard(): Promise<void>;
}

export interface ResultFile {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export class ExchangeFiles {
  constructor(
    private readonly _fileService: IUniverFileService,
    private readonly _logger: ILogger
  ) {}

  /** An `HttpImport` file assigned to the caller; anything else is reported as missing. */
  async requireUpload(fileID: string, context: FileCallContext): Promise<FileRecord> {
    const record = await this._fileService.getFile(fileID, context);
    if (!record || record.source !== FileSource.HttpImport || record.assign !== context.userID) {
      throw fileNotFound(fileID);
    }
    return record;
  }

  async read(fileID: string, context: FileCallContext): Promise<Buffer> {
    const { content } = await this._fileService.openFile(fileID, context);
    return collect(content);
  }

  /** `files.store` for a UNIT import: each file becomes `UnitEmbedded` with `assign = unitID`. */
  createUnitFileSink(unitID: string, context: FileCallContext): UnitFileSink {
    const stored: string[] = [];
    return {
      store: async (file) => {
        const record = await this._fileService.createFile(
          {
            name: file.name,
            contentType: file.mimeType || "application/octet-stream",
            source: FileSource.UnitEmbedded,
            assign: unitID,
            content: single(file.bytes),
          },
          context
        );
        stored.push(record.fileID);
        return { mode: "reference", source: record.fileID };
      },
      discard: async () => {
        for (const fileID of stored.splice(0)) await this.deleteQuietly(fileID, context);
      },
    };
  }

  /**
   * `files.load` for a `unitID` export. The snapshot is server-read and trusted: a reference must
   * name the exported Unit and an `UnitEmbedded` file of it, otherwise the export fails.
   */
  unitLoader(unitID: string, context: FileCallContext): IExportFilesOptions {
    return {
      load: async (ref) => {
        if (ref.sourceType === "URL") return { bytes: TRANSPARENT_PNG };
        const bytes = await this._loadEmbedded(ref, unitID, context);
        if (!bytes) throw fileNotFound(ref.source);
        return { bytes };
      },
    };
  }

  /**
   * `files.load` for a `jsonID` export. The snapshot is client-supplied: a reference that fails the
   * same checks against `snapshot.unitID` loads the placeholder instead.
   */
  snapshotLoader(unitID: string, context: FileCallContext): IExportFilesOptions {
    return {
      load: async (ref) => {
        if (ref.sourceType === "URL") return { bytes: TRANSPARENT_PNG };
        return { bytes: (await this._loadEmbedded(ref, unitID, context)) ?? TRANSPARENT_PNG };
      },
    };
  }

  /** Writes an export result or a JSON import result as `HttpExport` assigned to the caller. */
  async saveResult(file: ResultFile, context: FileCallContext): Promise<string> {
    const record = await this._fileService.createFile(
      {
        name: file.name,
        contentType: file.contentType,
        source: FileSource.HttpExport,
        assign: context.userID,
        content: single(file.bytes),
      },
      context
    );
    return record.fileID;
  }

  /** Deletes a file Exchange no longer needs; a failure only logs. */
  async deleteQuietly(fileID: string, context: FileCallContext): Promise<void> {
    try {
      await this._fileService.deleteFile(fileID, context);
    } catch (error) {
      this._logger.warn("Exchange could not delete a file", { fileID, error: errorMessage(error) });
    }
  }

  // The reference must name a UnitEmbedded file of ownerUnitID; otherwise undefined, and the caller
  // decides between failing and the placeholder.
  private async _loadEmbedded(
    ref: IExportFileRef,
    ownerUnitID: string,
    context: FileCallContext
  ): Promise<Uint8Array | undefined> {
    if (ref.unitId !== ownerUnitID) return undefined;
    const record = await this._fileService.getFile(ref.source, context);
    if (!record || record.source !== FileSource.UnitEmbedded || record.assign !== ownerUnitID) return undefined;
    return this.read(ref.source, context);
  }
}

async function collect(content: FileContent): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of content) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function* single(bytes: Uint8Array): FileContent {
  yield bytes;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
