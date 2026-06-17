/**
 * Prepared-statement SQL for node insert/update. Split out of node-queries.ts
 * to stay within the file-size gate.
 */

export const INSERT_NODE_SQL = `
  INSERT OR REPLACE INTO nodes (
    id, kind, name, qualified_name, file_path, language,
    start_line, end_line, start_column, end_column,
    docstring, signature, visibility,
    is_exported, is_async, is_static, is_abstract,
    decorators, type_parameters, updated_at
  ) VALUES (
    @id, @kind, @name, @qualifiedName, @filePath, @language,
    @startLine, @endLine, @startColumn, @endColumn,
    @docstring, @signature, @visibility,
    @isExported, @isAsync, @isStatic, @isAbstract,
    @decorators, @typeParameters, @updatedAt
  )
`;

export const UPDATE_NODE_SQL = `
  UPDATE nodes SET
    kind = @kind,
    name = @name,
    qualified_name = @qualifiedName,
    file_path = @filePath,
    language = @language,
    start_line = @startLine,
    end_line = @endLine,
    start_column = @startColumn,
    end_column = @endColumn,
    docstring = @docstring,
    signature = @signature,
    visibility = @visibility,
    is_exported = @isExported,
    is_async = @isAsync,
    is_static = @isStatic,
    is_abstract = @isAbstract,
    decorators = @decorators,
    type_parameters = @typeParameters,
    updated_at = @updatedAt
  WHERE id = @id
`;
