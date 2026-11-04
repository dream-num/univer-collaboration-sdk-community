import type { IncomingMessage } from "node:http";
import { pipeline, Transform, type Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";
import { Busboy, type BusboyHeaders, type BusboyInstance } from "@fastify/busboy";
import { FileError, type FileContent } from "@univerjs-pro/collaboration-file-service";

/** Query parameters of the upload route after normalization. */
export interface UploadQuery {
  readonly size?: number;
  readonly source: number;
  readonly assign: string;
  readonly flate: boolean;
}

/** The `file` multipart part, exposed as a stream plus its headers. */
export interface UploadPart {
  readonly name: string;
  readonly contentType: string;
  readonly content: FileContent;
  /** Stops the upload timer and abandons any unread content. Safe to call more than once. */
  release(): void;
}

export interface UploadReaderLimits {
  /** `undefined` means unlimited. Counted after inflate. */
  readonly maxBytes: number | undefined;
  readonly timeoutMs: number;
}

// Matches the Univer server: a value that does not parse keeps its default, and a source that is not
// an int32 integer becomes 0.
export function parseUploadQuery(url: URL): UploadQuery {
  const sizeRaw = url.searchParams.get("size");
  const size = sizeRaw === null ? undefined : Number(sizeRaw);
  const sourceValues = url.searchParams.getAll("source");
  const sourceRaw = sourceValues.length === 1 && sourceValues[0] !== "" ? Number(sourceValues[0]) : Number.NaN;
  const source = Number.isInteger(sourceRaw) && sourceRaw >= -2147483648 && sourceRaw <= 2147483647 ? sourceRaw : 0;
  return {
    ...(size !== undefined && Number.isFinite(size) ? { size } : {}),
    source,
    assign: url.searchParams.get("assign") ?? "",
    flate: url.searchParams.get("flate") === "true",
  };
}

/**
 * Reads the `file` part of a multipart request as a stream, inflating raw DEFLATE when `flate` is
 * set, counting bytes against `maxBytes` and aborting on timeout or client disconnect. It bypasses
 * Transport `readBody()` on purpose: uploads must not be buffered or capped by the global body limit.
 * Resolves once the part headers are parsed, before any content is read, so middleware runs first.
 */
export function readUploadPart(
  incomingMessage: IncomingMessage,
  query: UploadQuery,
  limits: UploadReaderLimits
): Promise<UploadPart> {
  return new Promise<UploadPart>((resolve, reject) => {
    const contentType = incomingMessage.headers["content-type"] ?? "";
    if (!/^multipart\/form-data\b/i.test(contentType)) {
      reject(new FileError("INVALID_REQUEST", "Upload must be multipart/form-data"));
      return;
    }

    let busboy: BusboyInstance;
    try {
      // The part named `file` is always the file, even without a filename, as the Univer server reads it.
      busboy = new Busboy({
        headers: incomingMessage.headers as BusboyHeaders,
        isPartAFile: (fieldName, _contentType, fileName) => fieldName === "file" || fileName !== undefined,
      });
    } catch (cause) {
      reject(new FileError("INVALID_REQUEST", "Malformed multipart request", { cause }));
      return;
    }

    let resolved = false;
    let finished = false;
    let output: Transform | undefined;

    const timer = setTimeout(() => fail(new FileError("UPLOAD_TIMEOUT", "Upload timed out")), limits.timeoutMs);
    timer.unref?.();

    const stop = () => {
      clearTimeout(timer);
      incomingMessage.off("close", onClose);
    };

    // Single failure path: before the part headers are parsed the promise rejects; afterwards the
    // content stream throws the same error.
    const fail = (error: FileError) => {
      if (finished) return;
      finished = true;
      stop();
      incomingMessage.unpipe(busboy);
      if (output) output.destroy(error);
      if (!resolved) reject(error);
    };

    const onClose = () => {
      if (!incomingMessage.complete) fail(new FileError("INVALID_REQUEST", "Client disconnected during upload"));
    };
    incomingMessage.on("close", onClose);

    busboy.on("file", (fieldName, stream: Readable, fileName, _encoding, mimeType) => {
      if (fieldName !== "file" || resolved || finished) {
        stream.resume();
        return;
      }
      let bytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.byteLength;
          if (limits.maxBytes !== undefined && bytes > limits.maxBytes) {
            callback(new FileError("PAYLOAD_TOO_LARGE", `Upload exceeds ${limits.maxBytes} bytes`));
            return;
          }
          callback(null, chunk);
        },
      });
      output = counter;
      const stages: Array<NodeJS.ReadableStream | NodeJS.WritableStream> = query.flate
        ? [stream, createInflateRaw(), counter]
        : [stream, counter];
      const toFileError = (error: unknown): FileError =>
        error instanceof FileError
          ? error
          : new FileError("INVALID_REQUEST", query.flate ? "Upload is not valid raw DEFLATE data" : "Upload stream failed", {
              cause: error,
            });
      pipeline(stages as [Readable, ...Transform[]], (error) => {
        if (!error) {
          finished = true;
          stop();
          return;
        }
        fail(toFileError(error));
      });
      // pipeline destroys the counter with the original error (for example from zlib) before its
      // callback runs, so the reader may see that error first. Mapping it to FileError here keeps the
      // Service from treating client data errors as storage failures.
      const content = (async function* () {
        try {
          yield* counter;
        } catch (error) {
          throw toFileError(error);
        }
      })();
      resolved = true;
      resolve({
        name: fileName ?? "",
        contentType: mimeType || "application/octet-stream",
        content,
        release: () => {
          if (finished) return;
          finished = true;
          stop();
          incomingMessage.unpipe(busboy);
          counter.destroy();
        },
      });
    });

    busboy.on("error", (cause: unknown) => fail(new FileError("INVALID_REQUEST", "Malformed multipart request", { cause })));
    busboy.on("finish", () => {
      if (!resolved) fail(new FileError("INVALID_REQUEST", "Multipart request has no file part"));
    });

    incomingMessage.pipe(busboy);
  });
}
