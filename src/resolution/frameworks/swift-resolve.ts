/**
 * Swift resolver dir/kind constants + resolveByNameAndKind split out of
 * swift.ts to keep it within the 200-line limit. No behavior change.
 */

import { ResolutionContext } from '../types';

export const VIEW_DIRS = ['/Views/', '/View/', '/Screens/', '/Components/', '/UI/'];
export const VIEWMODEL_DIRS = ['/ViewModels/', '/ViewModel/', '/Stores/', '/Managers/', '/Services/'];
export const MODEL_DIRS = ['/Models/', '/Model/', '/Entities/', '/Domain/'];
export const VC_DIRS = ['/ViewControllers/', '/ViewController/', '/Controllers/', '/Screens/'];
export const UIVIEW_DIRS = ['/Views/', '/View/', '/UI/', '/Components/'];
export const CELL_DIRS = ['/Cells/', '/Cell/', '/Views/', '/TableViewCells/', '/CollectionViewCells/'];
export const VAPOR_CONTROLLER_DIRS = ['/Controllers/', '/Controller/', '/Routes/'];
export const FLUENT_MODEL_DIRS = ['/Models/', '/Model/', '/Entities/', '/Database/'];
export const VAPOR_MIDDLEWARE_DIRS = ['/Middleware/', '/Middlewares/'];

export const VIEW_KINDS = new Set(['struct', 'component']);
export const CLASS_KINDS = new Set(['class']);
export const MODEL_KINDS = new Set(['struct', 'class']);
export const PROTOCOL_KINDS = new Set(['protocol']);
export const VAPOR_CONTROLLER_KINDS = new Set(['class', 'struct']);

/**
 * Resolve a symbol by name using indexed queries instead of scanning all files.
 */
export function resolveByNameAndKind(
  name: string,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  context: ResolutionContext,
): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const kindFiltered = candidates.filter((n) => kinds.has(n.kind));
  if (kindFiltered.length === 0) return null;

  // Prefer candidates in framework-conventional directories
  if (preferredDirPatterns.length > 0) {
    const preferred = kindFiltered.filter((n) =>
      preferredDirPatterns.some((d) => n.filePath.includes(d))
    );
    if (preferred.length > 0) return preferred[0]!.id;
  }

  // Fall back to any match
  return kindFiltered[0]!.id;
}
