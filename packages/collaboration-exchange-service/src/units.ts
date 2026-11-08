import {
  UnitSnapshotMaterializer,
  type CollabContext,
  type ISnapshotWithBlocks,
  type IUniverCollabService,
  type UnitLoadDataWithBlocks,
  type UnitRuntimeConfig,
} from "@univerjs-pro/collaboration-service";
import type { UniverType } from "@univerjs/protocol";

/**
 * The two collaboration Service methods Exchange calls. `UniverCollabService` satisfies it directly;
 * a wrapper must pass the context through unchanged.
 * @public
 */
export type IExchangeCollabService = Pick<IUniverCollabService, "createUnitFromSnapshot" | "getUnitLoadDataWithBlocks">;

/**
 * Where snapshots are materialized for `unitID` exports. Only `execution` applies: the materializer
 * releases each Unit when it finishes, so the cache options have no effect here.
 * @public
 */
export type ExchangeRuntimeConfig = Pick<UnitRuntimeConfig, "execution">;

// Reads the head revision.
const HEAD_REVISION = 0;

// Unit reads and writes go through the collaboration Service, so its readUnitData and createUnit
// middleware run as usual; snapshots come from the materializer this class owns.
export class ExchangeUnits {
  private readonly _materializer: UnitSnapshotMaterializer;

  constructor(
    private readonly _collabService: IExchangeCollabService,
    runtime?: ExchangeRuntimeConfig
  ) {
    this._materializer = new UnitSnapshotMaterializer(runtime);
  }

  /** Reads the Unit at its head revision with the caller's context (runs `readUnitData`). */
  read(unitID: string, type: UniverType, context: CollabContext): Promise<UnitLoadDataWithBlocks> {
    return this._collabService.getUnitLoadDataWithBlocks({ unitID, type, revision: HEAD_REVISION }, context);
  }

  materialize(data: UnitLoadDataWithBlocks): Promise<ISnapshotWithBlocks> {
    return this._materializer.materializeSnapshot(data);
  }

  /** Creates the imported Unit with the caller's context (runs `createUnit`). */
  async create(snapshot: ISnapshotWithBlocks, context: CollabContext): Promise<void> {
    const result = await this._collabService.createUnitFromSnapshot(snapshot, context);
    // Exchange generates the unitID at random, so an existing one can only be a UUID collision.
    if (result.status !== "created") throw new Error(`Unit ${result.unitID} already exists`);
  }

  dispose(): Promise<void> {
    return this._materializer.dispose();
  }
}
