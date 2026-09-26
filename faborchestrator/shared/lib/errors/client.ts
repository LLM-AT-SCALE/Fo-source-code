/**
 * FabOrch Audit — REQ-01 client-side error helpers.
 *
 * Mirror of the canonical catalog for browser code. This file is
 * intentionally framework-free so it can be imported from any
 * component, page, or hook without server dependencies.
 */

type FabOrchPriority = 'HIGH' | 'MEDIUM';

export interface FabOrchErrorEnvelope {
  errorId: string;
  type: string;
  priority: FabOrchPriority;
  message: string;
}

/**
 * Read a Response and either return the parsed JSON body or throw a
 * FabOrchClientError carrying the canonical envelope.
 */
export class FabOrchClientError extends Error {
  readonly envelope: FabOrchErrorEnvelope;
  readonly httpStatus: number;
  constructor(envelope: FabOrchErrorEnvelope, httpStatus: number) {
    super(envelope.message);
    this.name = 'FabOrchClientError';
    this.envelope = envelope;
    this.httpStatus = httpStatus;
  }
}
