/**
 * Swift Framework Resolver
 *
 * Handles SwiftUI, UIKit, and Vapor (server-side Swift) patterns.
 */


import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { extractSwiftUIRoutes, extractVaporRoutes } from './swift-extract';
import {
  VIEW_DIRS,
  VIEWMODEL_DIRS,
  MODEL_DIRS,
  VAPOR_CONTROLLER_DIRS,
  FLUENT_MODEL_DIRS,
  VAPOR_MIDDLEWARE_DIRS,
  VIEW_KINDS,
  CLASS_KINDS,
  MODEL_KINDS,
  VAPOR_CONTROLLER_KINDS,
  resolveByNameAndKind,
} from './swift-resolve';

export { uikitResolver } from './swift-uikit';

export const swiftUIResolver: FrameworkResolver = {
  name: 'swiftui',
  languages: ['swift'],

  detect(context: ResolutionContext): boolean {
    // Check for SwiftUI imports in Swift files
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file);
        if (content && content.includes('import SwiftUI')) {
          return true;
        }
      }
    }

    // Check for Xcode project with SwiftUI
    for (const file of allFiles) {
      if (file.endsWith('.xcodeproj') || file.endsWith('.xcworkspace')) {
        return true;
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: View references (SwiftUI views are PascalCase ending in View)
    if (ref.referenceName.endsWith('View') && /^[A-Z]/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, VIEW_KINDS, VIEW_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: ViewModel/ObservableObject references
    if (ref.referenceName.endsWith('ViewModel') || ref.referenceName.endsWith('Store') || ref.referenceName.endsWith('Manager')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, VIEWMODEL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Model references
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, MODEL_KINDS, MODEL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, content) {
    return extractSwiftUIRoutes(filePath, content);
  },
};

export const vaporResolver: FrameworkResolver = {
  name: 'vapor',
  languages: ['swift'],

  detect(context: ResolutionContext): boolean {
    // Check for Package.swift with Vapor dependency
    const packageSwift = context.readFile('Package.swift');
    if (packageSwift && packageSwift.includes('vapor')) {
      return true;
    }

    // Check for Vapor imports
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file);
        if (content && content.includes('import Vapor')) {
          return true;
        }
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Controller references
    if (ref.referenceName.endsWith('Controller')) {
      const result = resolveByNameAndKind(ref.referenceName, VAPOR_CONTROLLER_KINDS, VAPOR_CONTROLLER_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Model references (Fluent)
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, FLUENT_MODEL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.75,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Middleware references
    if (ref.referenceName.endsWith('Middleware')) {
      const result = resolveByNameAndKind(ref.referenceName, VAPOR_CONTROLLER_KINDS, VAPOR_MIDDLEWARE_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, content) {
    return extractVaporRoutes(filePath, content);
  },
};
