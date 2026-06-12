import type { Node as SyntaxNode } from 'web-tree-sitter';

import type { UnresolvedReference } from '../types';
import { getNodeText } from './tree-sitter-helpers';

type AddReference = (ref: UnresolvedReference) => void;

function emitReference(
  addReference: AddReference,
  fromNodeId: string,
  referenceName: string,
  referenceKind: 'extends' | 'implements',
  node: SyntaxNode
): void {
  addReference({
    fromNodeId,
    referenceName,
    referenceKind,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/**
 * Extract inheritance relationships from a class/interface/struct/enum node.
 */
export function extractInheritanceReferences(
  node: SyntaxNode,
  classId: string,
  source: string,
  addReference: AddReference
): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    if (
      child.type === 'extends_clause' ||
      child.type === 'superclass' ||
      child.type === 'base_clause' ||
      child.type === 'extends_interfaces'
    ) {
      const typeList = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_list');
      const targets = typeList ? typeList.namedChildren : [child.namedChild(0)];
      for (const target of targets) {
        if (target) {
          emitReference(
            addReference,
            classId,
            getNodeText(target, source),
            'extends',
            target
          );
        }
      }
    }

    if (
      child.type === 'implements_clause' ||
      child.type === 'class_interface_clause' ||
      child.type === 'super_interfaces' ||
      child.type === 'interfaces'
    ) {
      const typeList = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_list');
      const targets = typeList ? typeList.namedChildren : child.namedChildren;
      for (const iface of targets) {
        if (iface) {
          emitReference(
            addReference,
            classId,
            getNodeText(iface, source),
            'implements',
            iface
          );
        }
      }
    }

    // Python superclass list: `class Flask(Scaffold, Mixin):`
    if (child.type === 'argument_list' && node.type === 'class_definition') {
      for (const arg of child.namedChildren) {
        if (arg.type === 'identifier' || arg.type === 'attribute') {
          emitReference(addReference, classId, getNodeText(arg, source), 'extends', arg);
        }
      }
    }

    // Go interface embedding: `type Querier interface { LabelQuerier; ... }`
    if (child.type === 'constraint_elem') {
      const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      if (typeId) {
        emitReference(addReference, classId, getNodeText(typeId, source), 'extends', typeId);
      }
    }

    // Go struct embedding: field_declaration without field_identifier.
    if (child.type === 'field_declaration') {
      const hasFieldIdentifier = child.namedChildren.some(
        (c: SyntaxNode) => c.type === 'field_identifier'
      );
      if (!hasFieldIdentifier) {
        const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
        if (typeId) {
          emitReference(addReference, classId, getNodeText(typeId, source), 'extends', typeId);
        }
      }
    }

    // Rust trait supertraits: `trait SubTrait: SuperTrait + Display { ... }`
    if (child.type === 'trait_bounds') {
      for (const bound of child.namedChildren) {
        let typeName: string | undefined;
        let posNode: SyntaxNode | undefined;

        if (bound.type === 'type_identifier') {
          typeName = getNodeText(bound, source);
          posNode = bound;
        } else if (bound.type === 'generic_type') {
          const inner = bound.namedChildren.find(
            (c: SyntaxNode) => c.type === 'type_identifier'
          );
          if (inner) {
            typeName = getNodeText(inner, source);
            posNode = inner;
          }
        } else if (bound.type === 'higher_ranked_trait_bound') {
          const generic = bound.namedChildren.find(
            (c: SyntaxNode) => c.type === 'generic_type'
          );
          const typeId = generic?.namedChildren.find(
            (c: SyntaxNode) => c.type === 'type_identifier'
          ) ?? bound.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
          if (typeId) {
            typeName = getNodeText(typeId, source);
            posNode = typeId;
          }
        }

        if (typeName && posNode) {
          emitReference(addReference, classId, typeName, 'extends', posNode);
        }
      }
    }

    // C#: `class Movie : BaseItem, IPlugin`
    if (child.type === 'base_list') {
      for (const baseType of child.namedChildren) {
        if (baseType) {
          const name = baseType.type === 'generic_name'
            ? getNodeText(
              baseType.namedChildren.find((c: SyntaxNode) => c.type === 'identifier') ?? baseType,
              source
            )
            : getNodeText(baseType, source);
          emitReference(addReference, classId, name, 'extends', baseType);
        }
      }
    }

    // Kotlin: `class Foo : Bar, Baz`
    if (child.type === 'delegation_specifier') {
      const userType = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type');
      const constructorInvocation = child.namedChildren.find(
        (c: SyntaxNode) => c.type === 'constructor_invocation'
      );
      const target = userType ?? constructorInvocation;
      if (target) {
        const typeId = target.type === 'user_type'
          ? target.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier') ?? target
          : target.namedChildren.find((c: SyntaxNode) => c.type === 'user_type')?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier')
            ?? target.namedChildren.find((c: SyntaxNode) => c.type === 'user_type') ?? target;
        emitReference(addReference, classId, getNodeText(typeId, source), 'extends', typeId);
      }
    }

    // Swift inheritance_specifier > user_type > type_identifier.
    if (child.type === 'inheritance_specifier') {
      const userType = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type');
      const typeId = userType?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      if (typeId) {
        emitReference(addReference, classId, getNodeText(typeId, source), 'extends', typeId);
      }
    }

    // JavaScript class_heritage has bare identifier without extends_clause wrapper.
    if (
      (child.type === 'identifier' || child.type === 'type_identifier') &&
      node.type === 'class_heritage'
    ) {
      emitReference(addReference, classId, getNodeText(child, source), 'extends', child);
    }

    if (child.type === 'field_declaration_list' || child.type === 'class_heritage') {
      extractInheritanceReferences(child, classId, source, addReference);
    }
  }
}
