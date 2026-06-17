import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';
import { visitKotlinNode } from './kotlin-fun-interface';

export const kotlinExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: ['class_declaration'],
  methodTypes: ['function_declaration'], // Methods are functions inside classes
  interfaceTypes: [], // Handled via classifyClassNode
  structTypes: [], // Kotlin uses data classes
  enumTypes: [], // Handled via classifyClassNode
  enumMemberTypes: ['enum_entry'],
  typeAliasTypes: ['type_alias'],
  importTypes: ['import_header'],
  callTypes: ['call_expression'],
  variableTypes: ['property_declaration'],
  fieldTypes: ['property_declaration'],
  extraClassNodeTypes: ['object_declaration'],
  nameField: 'simple_identifier',
  bodyField: 'function_body',
  visitNode: visitKotlinNode,
  paramsField: 'function_value_parameters',
  returnField: 'type',
  resolveBody: (node, _bodyField) => {
    // Kotlin's tree-sitter grammar doesn't use field names, so getChildByField fails.
    // Find body by type: function_body for functions/methods, class_body for classes,
    // enum_class_body for enums.
    //
    // Special case: when a class/interface contains a nested `fun interface`, tree-sitter
    // misparsed the parent's body as an ERROR node (starting with `{`) and creates
    // a class_body sibling for the nested interface's body. Prefer the ERROR body
    // so the parent's methods are extracted.
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && child.type === 'ERROR') {
        const firstChild = child.child(0);
        if (firstChild && firstChild.type === '{') {
          return child;
        }
      }
      if (child && (child.type === 'function_body' || child.type === 'class_body' || child.type === 'enum_class_body')) {
        return child;
      }
    }
    return null;
  },
  classifyClassNode: (node) => {
    // Kotlin reuses class_declaration for classes, interfaces, and enums.
    // Detect by checking for keyword children:
    //   interface Foo { }       → has 'interface' keyword child
    //   enum class Level { }    → has 'enum' keyword child
    //   class / data class / abstract class → default 'class'
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (child.type === 'interface') return 'interface';
      if (child.type === 'enum') return 'enum';
    }
    return 'class';
  },
  getReceiverType: (node, source) => {
    // Kotlin extension functions: fun Type.method() { }
    // AST: function_declaration > user_type, ".", simple_identifier
    // The user_type before the dot is the receiver type.
    let foundUserType: SyntaxNode | null = null;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (child.type === 'user_type') {
        foundUserType = child;
      } else if (child.type === '.' && foundUserType) {
        // The user_type before the dot is the receiver type
        const typeId = foundUserType.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
        return typeId ? getNodeText(typeId, source) : getNodeText(foundUserType, source);
      } else if (child.type === 'simple_identifier' || child.type === 'function_value_parameters') {
        // Past the function name — no receiver
        break;
      }
    }
    return undefined;
  },
  getSignature: (node, source) => {
    // Kotlin function signature: fun name(params): ReturnType
    const params = getChildByField(node, 'function_value_parameters');
    const returnType = getChildByField(node, 'type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ': ' + getNodeText(returnType, source);
    }
    return sig;
  },
  getVisibility: (node) => {
    // Check for visibility modifiers in Kotlin
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        const text = child.text;
        if (text.includes('public')) return 'public';
        if (text.includes('private')) return 'private';
        if (text.includes('protected')) return 'protected';
        if (text.includes('internal')) return 'internal';
      }
    }
    return 'public'; // Kotlin defaults to public
  },
  isStatic: (_node) => {
    // Kotlin doesn't have static, uses companion objects
    return false;
  },
  isAsync: (node) => {
    // Kotlin uses suspend keyword for coroutines
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers' && child.text.includes('suspend')) {
        return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (identifier) {
      return { moduleName: source.substring(identifier.startIndex, identifier.endIndex), signature: importText };
    }
    return null;
  },
};
