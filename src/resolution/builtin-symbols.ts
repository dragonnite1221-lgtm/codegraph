/**
 * Built-in symbol tables
 *
 * Per-language sets of language built-ins, standard-library packages, and
 * common library calls. Used to skip resolution for references that point at
 * the runtime/stdlib rather than a symbol in the indexed codebase.
 */

import type { UnresolvedRef } from './types';

// Pre-built Sets for O(1) built-in lookups (allocated once, shared across all instances)
const JS_BUILT_INS = new Set([
  'console', 'window', 'document', 'global', 'process',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'Date', 'Math', 'JSON', 'RegExp', 'Error', 'Map', 'Set',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'fetch', 'require', 'module', 'exports', '__dirname', '__filename',
]);

const REACT_HOOKS = new Set([
  'useState', 'useEffect', 'useContext', 'useReducer', 'useCallback',
  'useMemo', 'useRef', 'useLayoutEffect', 'useImperativeHandle', 'useDebugValue',
]);

const PYTHON_BUILT_INS = new Set([
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
  'open', 'input', 'type', 'isinstance', 'hasattr', 'getattr', 'setattr',
  'super', 'self', 'cls', 'None', 'True', 'False',
]);

const PYTHON_BUILT_IN_TYPES = new Set([
  'list', 'dict', 'set', 'tuple', 'str', 'int', 'float', 'bool',
  'bytes', 'bytearray', 'frozenset', 'object', 'super',
]);

const PYTHON_BUILT_IN_METHODS = new Set([
  'append', 'extend', 'insert', 'remove', 'pop', 'clear', 'sort', 'reverse', 'copy',
  'update', 'keys', 'values', 'items', 'get',
  'add', 'discard', 'union', 'intersection', 'difference',
  'split', 'join', 'strip', 'lstrip', 'rstrip', 'replace', 'lower', 'upper',
  'startswith', 'endswith', 'find', 'index', 'count', 'encode', 'decode',
  'format', 'isdigit', 'isalpha', 'isalnum',
  'read', 'write', 'readline', 'readlines', 'close', 'flush', 'seek',
]);

const GO_STDLIB_PACKAGES = new Set([
  'fmt', 'os', 'io', 'net', 'http', 'log', 'math', 'sort', 'sync',
  'time', 'path', 'bytes', 'strings', 'strconv', 'errors', 'context',
  'json', 'xml', 'csv', 'html', 'template', 'regexp', 'reflect',
  'runtime', 'testing', 'flag', 'bufio', 'crypto', 'encoding',
  'filepath', 'hash', 'mime', 'rand', 'signal', 'sql', 'syscall',
  'unicode', 'unsafe', 'atomic', 'binary', 'debug', 'exec', 'heap',
  'ring', 'scanner', 'tar', 'zip', 'gzip', 'zlib', 'tls', 'url',
  'user', 'pprof', 'trace', 'ast', 'build', 'parser', 'printer',
  'token', 'types', 'cgo', 'plugin', 'race', 'ioutil',
  // Kubernetes-common stdlib aliases
  'utilruntime', 'utilwait', 'utilnet',
]);

const GO_BUILT_INS = new Set([
  'make', 'new', 'len', 'cap', 'append', 'copy', 'delete', 'close',
  'panic', 'recover', 'print', 'println', 'complex', 'real', 'imag',
  'error', 'nil', 'true', 'false', 'iota',
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128',
  'string', 'bool', 'byte', 'rune', 'any',
]);

const PASCAL_UNIT_PREFIXES = [
  'System.', 'Winapi.', 'Vcl.', 'Fmx.', 'Data.', 'Datasnap.',
  'Soap.', 'Xml.', 'Web.', 'REST.', 'FireDAC.', 'IBX.',
  'IdHTTP', 'IdTCP', 'IdSSL',
];

const PASCAL_BUILT_INS = new Set([
  'System', 'SysUtils', 'Classes', 'Types', 'Variants', 'StrUtils',
  'Math', 'DateUtils', 'IOUtils', 'Generics.Collections', 'Generics.Defaults',
  'Rtti', 'TypInfo', 'SyncObjs', 'RegularExpressions',
  'SysInit', 'Windows', 'Messages', 'Graphics', 'Controls', 'Forms',
  'Dialogs', 'StdCtrls', 'ExtCtrls', 'ComCtrls', 'Menus', 'ActnList',
  'WriteLn', 'Write', 'ReadLn', 'Read', 'Inc', 'Dec', 'Ord', 'Chr',
  'Length', 'SetLength', 'High', 'Low', 'Assigned', 'FreeAndNil',
  'Format', 'IntToStr', 'StrToInt', 'FloatToStr', 'StrToFloat',
  'Trim', 'UpperCase', 'LowerCase', 'Pos', 'Copy', 'Delete', 'Insert',
  'Now', 'Date', 'Time', 'DateToStr', 'StrToDate',
  'Raise', 'Exit', 'Break', 'Continue', 'Abort',
  'True', 'False', 'nil', 'Self', 'Result',
  'Create', 'Destroy', 'Free',
  'TObject', 'TComponent', 'TPersistent', 'TInterfacedObject',
  'TList', 'TStringList', 'TStrings', 'TStream', 'TMemoryStream', 'TFileStream',
  'Exception', 'EAbort', 'EConvertError', 'EAccessViolation',
  'IInterface', 'IUnknown',
]);

/**
 * Check if a reference points at a language built-in or external stdlib symbol.
 * `knownNames` is the resolver's pre-built symbol-name set, used to avoid
 * misclassifying a method call whose receiver matches a real codebase class.
 */
export function isBuiltInOrExternal(
  ref: UnresolvedRef,
  knownNames: Set<string> | null
): boolean {
  const name = ref.referenceName;
  const isJsTs = ref.language === 'typescript' || ref.language === 'javascript'
    || ref.language === 'tsx' || ref.language === 'jsx';

  // JavaScript/TypeScript built-ins
  if (isJsTs && JS_BUILT_INS.has(name)) {
    return true;
  }

  // Common JS/TS library calls (console.log, Math.floor, JSON.parse)
  if (isJsTs && (name.startsWith('console.') || name.startsWith('Math.') || name.startsWith('JSON.'))) {
    return true;
  }

  // React hooks from React itself
  if (isJsTs && REACT_HOOKS.has(name)) {
    return true;
  }

  // Python built-ins (bare calls only — dotted calls like console.print are method calls)
  if (ref.language === 'python' && PYTHON_BUILT_INS.has(name)) {
    return true;
  }

  // Python built-in method calls (e.g., list.extend, dict.update)
  if (ref.language === 'python') {
    const dotIdx = name.indexOf('.');
    if (dotIdx > 0) {
      const receiver = name.substring(0, dotIdx);
      const method = name.substring(dotIdx + 1);
      // Filter calls on built-in types (list.append, dict.update, etc.)
      if (PYTHON_BUILT_IN_TYPES.has(receiver)) {
        return true;
      }
      // Filter built-in methods on non-class receivers
      // (e.g., items.append where items is a local list variable)
      // But allow if the capitalized receiver matches a known codebase class
      if (PYTHON_BUILT_IN_METHODS.has(method)) {
        const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
        if (!knownNames?.has(capitalized)) {
          return true;
        }
      }
    }
    if (PYTHON_BUILT_IN_METHODS.has(name)) {
      return true;
    }
  }

  // Go standard library packages — refs like "fmt.Println", "http.ListenAndServe", etc.
  if (ref.language === 'go') {
    const dotIdx = name.indexOf('.');
    if (dotIdx > 0) {
      const pkg = name.substring(0, dotIdx);
      if (GO_STDLIB_PACKAGES.has(pkg)) {
        return true;
      }
    }
    if (GO_BUILT_INS.has(name)) {
      return true;
    }
  }

  // Pascal/Delphi built-ins and standard library units
  if (ref.language === 'pascal') {
    if (PASCAL_UNIT_PREFIXES.some((p) => name.startsWith(p))) {
      return true;
    }
    if (PASCAL_BUILT_INS.has(name)) {
      return true;
    }
  }

  return false;
}
