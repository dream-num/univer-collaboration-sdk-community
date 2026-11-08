import { ExchangeServiceError } from "./errors.js";
import type { ExchangeFiles } from "./files.js";
import type { ExchangeUnits } from "./units.js";

/** What a background job may touch. The Service owns all three and their lifecycle. */
export interface JobEnvironment {
  readonly files: ExchangeFiles;
  readonly units: ExchangeUnits;
  /** False once the Service is disposed. */
  isRunning(): boolean;
}

// dispose does not wait for conversions in progress and discards their results. Jobs check this after
// converting so no Unit is created and no result file is written after dispose.
export function assertRunning(environment: JobEnvironment): void {
  if (!environment.isRunning()) throw new ExchangeServiceError("SERVICE_DISPOSED", "Exchange Service is disposed");
}
