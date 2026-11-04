import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  FileError,
  type FileBlobContext,
  type FileContent,
  type IFileBlobStore,
  type PutBlobInput,
  type PutBlobResult,
} from "@univerjs-pro/collaboration-file-service";

/** @public */
export interface LocalFileBlobStoreOptions {
  /** Directory that holds the objects. Created if it does not exist. */
  readonly directory: string;
}

// The blobKey is the file name, so only names that cannot escape the directory are accepted;
// temporary files start with "." to stay apart from objects.
const SAFE_KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * Local directory blob store for single-node deployments. Each object is stored as
 * `<directory>/<fileID>`, so the `blobKey` is the `fileID`. Content is written to a temporary file
 * first and renamed into place, so a failed upload never leaves a partial object. It does not sign
 * direct links; downloads go through the proxy route.
 * @public
 */
export class LocalFileBlobStore implements IFileBlobStore {
  private readonly _directory: string;

  constructor(options: LocalFileBlobStoreOptions) {
    if (!options?.directory) throw new TypeError("LocalFileBlobStore requires a directory");
    this._directory = resolve(options.directory);
    mkdirSync(this._directory, { recursive: true });
  }

  async put(input: PutBlobInput, _context: FileBlobContext): Promise<PutBlobResult> {
    if (!SAFE_KEY.test(input.fileID)) {
      throw new FileError("INVALID_REQUEST", "fileID cannot be used as a local file name");
    }
    const target = join(this._directory, input.fileID);
    const temporary = join(this._directory, `.${input.fileID}.${randomUUID()}.tmp`);
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.byteLength;
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.from(input.content), counter, createWriteStream(temporary, { flags: "wx" }));
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return { blobKey: input.fileID, size };
  }

  async open(blobKey: string, _context: FileBlobContext): Promise<FileContent> {
    // Opening the handle first reports FILE_NOT_FOUND here instead of failing later while streaming.
    const handle = SAFE_KEY.test(blobKey)
      ? await open(join(this._directory, blobKey), "r").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        })
      : undefined;
    if (!handle) throw new FileError("FILE_NOT_FOUND", `Content ${blobKey} does not exist`);
    return createReadStream("", { fd: handle });
  }

  async delete(blobKey: string, _context: FileBlobContext): Promise<void> {
    if (!SAFE_KEY.test(blobKey)) return;
    await rm(join(this._directory, blobKey), { force: true });
  }

  async dispose(): Promise<void> {}
}
