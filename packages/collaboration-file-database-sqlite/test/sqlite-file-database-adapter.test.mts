import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "libsql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteFileDatabaseAdapter } from "../src/index.js";

const context = { userID: "u", customData: {}, request: { fileID: "f" } };
const record = { fileID: "a", name: "a", size: 1, contentType: "text/plain", source: 3, assign: "u", blobKey: "a", createdAt: 1 };

describe("SQLiteFileDatabaseAdapter", () => {
  let directory: string;
  let filename: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "univer-collab-file-sqlite-"));
    filename = join(directory, "files.sqlite");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("requires a filename", () => {
    expect(() => new SQLiteFileDatabaseAdapter({ filename: "" })).toThrow(TypeError);
  });

  it("reopens an existing database and keeps its records", async () => {
    const first = new SQLiteFileDatabaseAdapter({ filename });
    await first.create(record, context);
    await first.dispose();
    const second = new SQLiteFileDatabaseAdapter({ filename });
    try {
      expect(await second.get("a", context)).toEqual(record);
    } finally {
      await second.dispose();
    }
  });

  it("registers its schema version next to other components", async () => {
    const database = new Database(filename);
    database.exec(`
      CREATE TABLE collaboration_schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO collaboration_schema_versions VALUES ('comment', 1);
    `);
    database.close();
    await new SQLiteFileDatabaseAdapter({ filename }).dispose();
    const inspect = new Database(filename);
    try {
      expect(inspect.prepare("SELECT component, version FROM collaboration_schema_versions ORDER BY component").all()).toMatchObject([
        { component: "comment", version: 1 },
        { component: "file", version: 1 },
      ]);
    } finally {
      inspect.close();
    }
  });

  it("rejects a different file schema version", async () => {
    await new SQLiteFileDatabaseAdapter({ filename }).dispose();
    const database = new Database(filename);
    database.exec("UPDATE collaboration_schema_versions SET version = 2 WHERE component = 'file'");
    database.close();
    expect(() => new SQLiteFileDatabaseAdapter({ filename })).toThrow(/version 2 is not supported/);
  });
});
