import { fileBlobStoreContract } from "@univerjs-pro/collaboration-file-blob-testkit";
import { fileDatabaseAdapterContract } from "@univerjs-pro/collaboration-file-database-testkit";
import { MemoryFileBlobStore, MemoryFileDatabaseAdapter } from "../src/index.js";

fileDatabaseAdapterContract("Memory", () => {
  const adapter = new MemoryFileDatabaseAdapter();
  return { adapter, dispose: () => adapter.dispose() };
});

fileBlobStoreContract("Memory", () => {
  const store = new MemoryFileBlobStore();
  return { store, dispose: () => store.dispose() };
});
