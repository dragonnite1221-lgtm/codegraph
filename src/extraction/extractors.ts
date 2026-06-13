/**
 * Tree-sitter symbol extractors (barrel)
 *
 * Re-exports the per-construct extraction routines, split across
 * extractors-decl (functions/classes/methods/members) and extractors-misc
 * (types/imports/calls/decorators/inheritance) to keep each file focused.
 */

export * from './extractors-decl';
export * from './extractors-misc';
