/**
 * FabOrch Audit — REQ-01 catalog DEFAULTS.
 *
 * This file holds the FabOrchErrorType enum, FabOrchErrorPriority enum,
 * FabOrchErrorEntry interface, and the frozen FABORCH_ERROR_CATALOG
 * constant. Both `faborch-errors.ts` and `error-catalog-loader.ts` import
 * from here so neither has to import from the other.
 *
 * Why this file exists: previously the loader imported the catalog from
 * faborch-errors AND faborch-errors imported `getErrorEntry` from the
 * loader — a circular import. Webpack resolves circular imports by
 * sometimes returning a half-initialised module namespace, which made
 * `FabOrchError.invalidParameter(...)` fail at runtime with "Cannot read
 * properties of undefined (reading 'invalidParameter')". Splitting the
 * defaults into a leaf module (this file) breaks the cycle entirely.
 */

export enum FabOrchErrorType {
  SQL_CALL_FAILURE = 'SQL_CALL_FAILURE',
  RESPONSE_TIMEOUT = 'RESPONSE_TIMEOUT',
  NO_ROWS_RETURNED = 'NO_ROWS_RETURNED',
  MISSING_FILTER = 'MISSING_FILTER',
  INVALID_PARAMETER = 'INVALID_PARAMETER',
  DDL_DML_REJECTED = 'DDL_DML_REJECTED',
  LAMBDA_MCP_CRASH = 'LAMBDA_MCP_CRASH',
  SESSION_TIMEOUT = 'SESSION_TIMEOUT',
  ROW_CAP_EXCEEDED = 'ROW_CAP_EXCEEDED',
  UNLISTED_STORED_PROC = 'UNLISTED_STORED_PROC',
}

export enum FabOrchErrorPriority {
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
}

export interface FabOrchErrorEntry {
  type: FabOrchErrorType;
  priority: FabOrchErrorPriority;
  userMessage: string;
  httpStatus: number;
}

export const FABORCH_ERROR_CATALOG: Readonly<
  Record<FabOrchErrorType, FabOrchErrorEntry>
> = Object.freeze({
  [FabOrchErrorType.SQL_CALL_FAILURE]: {
    type: FabOrchErrorType.SQL_CALL_FAILURE,
    priority: FabOrchErrorPriority.HIGH,
    userMessage: 'I cannot reach the data right now. Please retry.',
    httpStatus: 503,
  },
  [FabOrchErrorType.RESPONSE_TIMEOUT]: {
    type: FabOrchErrorType.RESPONSE_TIMEOUT,
    priority: FabOrchErrorPriority.HIGH,
    userMessage:
      'The request took too long to complete. Please try again or narrow your request.',
    httpStatus: 504,
  },
  [FabOrchErrorType.NO_ROWS_RETURNED]: {
    type: FabOrchErrorType.NO_ROWS_RETURNED,
    priority: FabOrchErrorPriority.HIGH,
    userMessage: 'No data found for that request.',
    httpStatus: 404,
  },
  [FabOrchErrorType.MISSING_FILTER]: {
    type: FabOrchErrorType.MISSING_FILTER,
    priority: FabOrchErrorPriority.HIGH,
    userMessage:
      'I need one more detail before I can answer that. Could you clarify?',
    httpStatus: 400,
  },
  [FabOrchErrorType.INVALID_PARAMETER]: {
    type: FabOrchErrorType.INVALID_PARAMETER,
    priority: FabOrchErrorPriority.HIGH,
    userMessage:
      'That value is not valid. Please choose one of the available options.',
    httpStatus: 400,
  },
  [FabOrchErrorType.DDL_DML_REJECTED]: {
    type: FabOrchErrorType.DDL_DML_REJECTED,
    priority: FabOrchErrorPriority.HIGH,
    userMessage: 'That operation is not permitted.',
    httpStatus: 403,
  },
  [FabOrchErrorType.LAMBDA_MCP_CRASH]: {
    type: FabOrchErrorType.LAMBDA_MCP_CRASH,
    priority: FabOrchErrorPriority.HIGH,
    userMessage:
      'A backend service is temporarily unavailable. Please try again in a moment.',
    httpStatus: 500,
  },
  [FabOrchErrorType.SESSION_TIMEOUT]: {
    type: FabOrchErrorType.SESSION_TIMEOUT,
    priority: FabOrchErrorPriority.MEDIUM,
    userMessage: 'Your session has expired. Please log in again.',
    httpStatus: 401,
  },
  [FabOrchErrorType.ROW_CAP_EXCEEDED]: {
    type: FabOrchErrorType.ROW_CAP_EXCEEDED,
    priority: FabOrchErrorPriority.MEDIUM,
    userMessage:
      'Returned the first 1000 rows. Please refine your filter to narrow the results.',
    httpStatus: 200,
  },
  [FabOrchErrorType.UNLISTED_STORED_PROC]: {
    type: FabOrchErrorType.UNLISTED_STORED_PROC,
    priority: FabOrchErrorPriority.MEDIUM,
    userMessage: 'That procedure is not available.',
    httpStatus: 404,
  },
});

export const ROW_CAP_LIMIT = 1000;
