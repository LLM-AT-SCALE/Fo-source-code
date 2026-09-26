/**
 * Replay runtime — public surface.
 *
 * `runProgram(program, template, ctx)` executes a compiled dashboard program
 * through the MCP client and fills its HTML template. Everything else here is
 * the building blocks (schema, expressions, binder) exposed for the compiler
 * and for tests.
 */

export * from './program';
export * from './paths';
export * from './expressions';
export * from './mcp-result';
export * from './servers';
export { bindTemplate, formatValue, stampMeta, type BindOptions, type BindResult } from './bind';
export * from './summary';
export * from './columns';
export * from './execute';
