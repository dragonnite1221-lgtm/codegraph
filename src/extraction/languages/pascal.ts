import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

export const pascalExtractor: LanguageExtractor = {
  functionTypes: ['declProc'],
  classTypes: ['declClass'],
  methodTypes: ['declProc'],
  interfaceTypes: ['declIntf'],
  structTypes: [],
  enumTypes: ['declEnum'],
  typeAliasTypes: ['declType'],
  importTypes: ['declUses'],
  callTypes: ['exprCall'],
  variableTypes: ['declField', 'declConst'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'args',
  returnField: 'type',
  getSignature: (node, source) => {
    const args = getChildByField(node, 'args');
    const returnType = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'typeref'
    );
    if (!args && !returnType) return undefined;
    let sig = '';
    if (args) sig = getNodeText(args, source);
    if (returnType) {
      sig += ': ' + getNodeText(returnType, source);
    }
    return sig || undefined;
  },
  getVisibility: (node) => {
    let current = node.parent;
    while (current) {
      if (current.type === 'declSection') {
        for (let i = 0; i < current.childCount; i++) {
          const child = current.child(i);
          if (child?.type === 'kPublic' || child?.type === 'kPublished')
            return 'public';
          if (child?.type === 'kPrivate') return 'private';
          if (child?.type === 'kProtected') return 'protected';
        }
      }
      current = current.parent;
    }
    return undefined;
  },
  // No isExported hook: this used to unconditionally `return false`
  // (contradicting its own comment that interface-section symbols ARE
  // exported), which meant every Pascal node reported isExported: false
  // regardless of section. Since node.isExported is otherwise undefined
  // (falsy) for Pascal either way, dropping the hook is behavior-neutral
  // for every existing false-check (`if (candidate.isExported)`); it only
  // stops confidently reporting "not exported" for symbols that are.
  // Properly distinguishing interface vs. implementation section requires
  // walking up to the grammar's `interface`/`implementation` section nodes
  // (see pascal-visitor.ts) and is left as a follow-up.
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      if (node.child(i)?.type === 'kClass') return true;
    }
    return false;
  },
  isConst: (node) => {
    return node.type === 'declConst';
  },
};
