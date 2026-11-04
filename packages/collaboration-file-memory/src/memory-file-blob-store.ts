import {
  FileError,
  type FileContent,
  type FileBlobContext,
  type IFileBlobStore,
  type PutBlobInput,
  type PutBlobResult,
} from "@univerjs-pro/collaboration-file-service";

/**
 * In-memory blob store for tests and demos. Uses `fileID` as the `blobKey` and leaves `signUrl`
 * unimplemented on purpose, so every download goes through the proxy route.
 * @public
 */
export class MemoryFileBlobStore implements IFileBlobStore {
  private readonly _objects = new Map<string, Uint8Array>();

  async put(input: PutBlobInput, _context: FileBlobContext): Promise<PutBlobResult> {
    // The whole stream is read before the Map is written, so a failing stream leaves nothing behind.
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of input.content) {
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    this._objects.set(input.fileID, concat(chunks, size));
    return { blobKey: input.fileID, size };
  }

  async open(blobKey: string, _context: FileBlobContext): Promise<FileContent> {
    const bytes = this._objects.get(blobKey);
    if (!bytes) throw new FileError("FILE_NOT_FOUND", `Content ${blobKey} does not exist`);
    return (async function* () {
      yield bytes;
    })();
  }

  async delete(blobKey: string, _context: FileBlobContext): Promise<void> {
    this._objects.delete(blobKey);
  }

  async dispose(): Promise<void> {
    this._objects.clear();
  }
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
