import { DomainErrorCode } from "./schemas/types.js";
// representa violações de regra do negócio
export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);

    this.name = "DomainError";
  }
}

//PendingClassificationNotFoundError

//CategoryNotFoundError