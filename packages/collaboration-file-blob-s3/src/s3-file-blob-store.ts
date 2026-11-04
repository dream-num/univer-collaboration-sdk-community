import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { create as createContentDisposition } from "content-disposition";
import {
  FileError,
  type DirectUrl,
  type FileBlobContext,
  type FileContent,
  type IFileBlobStore,
  type PutBlobInput,
  type PutBlobResult,
  type SignDirectUrlInput,
} from "@univerjs-pro/collaboration-file-service";

const DEFAULT_DIRECT_URL_EXPIRES_IN_SECONDS = 3600;

/** @public */
export interface S3FileBlobStoreDirectUrlOptions {
  /**
   * Signing-only client; it sends no requests. Configure it with the endpoint browsers can reach,
   * pointing to the same storage and bucket as the main client, with the same region and addressing
   * style and credentials allowed to read the objects. Pass the main client when both sides reach
   * the storage at the same address.
   */
  readonly client: S3Client;
  /** Lifetime of a signed URL. Defaults to 3600. */
  readonly expiresInSeconds?: number;
}

/** @public */
export interface S3FileBlobStoreOptions {
  /** Application-owned client used for reads and writes. The store never destroys it. */
  readonly client: S3Client;
  readonly bucket: string;
  /** Object key prefix. Objects are stored at `{prefix}/{fileID}`, or `{fileID}` when omitted. */
  readonly prefix?: string;
  /** Enables `signUrl`. Without it every download goes through the proxy route. */
  readonly directUrl?: S3FileBlobStoreDirectUrlOptions;
}

/**
 * S3-compatible blob store. Uploads stream through `@aws-sdk/lib-storage` multipart uploads, which
 * abort on failure; the bucket still needs an `AbortIncompleteMultipartUpload` lifecycle rule for
 * uploads interrupted by a crash. When `directUrl` is configured, `signUrl` returns presigned GET
 * URLs that force `attachment` like the proxy route.
 * @public
 */
export class S3FileBlobStore implements IFileBlobStore {
  private readonly _client: S3Client;
  private readonly _bucket: string;
  private readonly _prefix: string;
  private readonly _signer: S3Client | undefined;
  private readonly _expiresInSeconds: number;

  constructor(options: S3FileBlobStoreOptions) {
    if (!options?.client) throw new TypeError("S3FileBlobStore requires a client");
    if (!options.bucket) throw new TypeError("S3FileBlobStore requires a bucket");
    const prefix = options.prefix ?? "";
    if (prefix.startsWith("/") || prefix.endsWith("/")) {
      throw new TypeError("prefix must not start or end with a slash");
    }
    const expiresInSeconds = options.directUrl?.expiresInSeconds ?? DEFAULT_DIRECT_URL_EXPIRES_IN_SECONDS;
    // S3 presigned URLs are valid for at most 7 days.
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds <= 0 || expiresInSeconds > 604_800) {
      throw new TypeError("directUrl.expiresInSeconds must be an integer between 1 and 604800");
    }
    if (options.directUrl && !options.directUrl.client) {
      throw new TypeError("directUrl requires a signing client");
    }
    this._client = options.client;
    this._bucket = options.bucket;
    this._prefix = prefix;
    this._signer = options.directUrl?.client;
    this._expiresInSeconds = expiresInSeconds;
  }

  async put(input: PutBlobInput, _context: FileBlobContext): Promise<PutBlobResult> {
    const blobKey = this._prefix ? `${this._prefix}/${input.fileID}` : input.fileID;
    let size = 0;
    const counted = (async function* () {
      for await (const chunk of input.content) {
        size += chunk.byteLength;
        yield chunk;
      }
    })();
    // The length is unknown up front: Upload splits the data it reads into parts and aborts the
    // multipart upload on failure, leaving nothing behind.
    await new Upload({
      client: this._client,
      params: { Bucket: this._bucket, Key: blobKey, Body: Readable.from(counted), ContentType: input.contentType },
    }).done();
    return { blobKey, size };
  }

  async open(blobKey: string, _context: FileBlobContext): Promise<FileContent> {
    try {
      const result = await this._client.send(new GetObjectCommand({ Bucket: this._bucket, Key: blobKey }));
      if (!result.Body) throw new FileError("FILE_NOT_FOUND", `Content ${blobKey} does not exist`);
      return result.Body as Readable;
    } catch (error) {
      if (isNotFound(error)) throw new FileError("FILE_NOT_FOUND", `Content ${blobKey} does not exist`);
      throw error;
    }
  }

  // S3 reports success when deleting a missing key, which matches the contract.
  async delete(blobKey: string, _context: FileBlobContext): Promise<void> {
    try {
      await this._client.send(new DeleteObjectCommand({ Bucket: this._bucket, Key: blobKey }));
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }

  async signUrl(input: SignDirectUrlInput, _context: FileBlobContext): Promise<DirectUrl | null> {
    if (!this._signer) return null;
    const url = await getSignedUrl(
      this._signer,
      new GetObjectCommand({
        Bucket: this._bucket,
        Key: input.blobKey,
        ResponseContentType: input.record.contentType,
        // The same RFC 6266 header the proxy route sends.
        ResponseContentDisposition: createContentDisposition(input.record.name),
      }),
      { expiresIn: this._expiresInSeconds }
    );
    return { url, expiresAt: Date.now() + this._expiresInSeconds * 1000 };
  }

  // The client belongs to the application and is not destroyed here.
  async dispose(): Promise<void> {}
}

function isNotFound(error: unknown): boolean {
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  return candidate?.name === "NoSuchKey" || candidate?.name === "NotFound" || candidate?.$metadata?.httpStatusCode === 404;
}
