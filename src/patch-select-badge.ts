import type { PatchSiteResult } from './patch-transforms.js';

const MARKER = '/*ccpatch:select-badge*/';
const NAME = 'PATCH 5b: model picker option badge';
// Because themed purple keys follow light and dark mode, the badge uses one.
const BADGE_COLOR = 'autoAccept';
const IDENT = '[A-Za-z_$][\\w$]*';
const DESCRIPTION_CELL = new RegExp(
  '(flexGrow:1,marginLeft:2,children:)'
  + `(${IDENT})\\((${IDENT}),\\{wrap:"wrap",dimColor:(${IDENT})\\.option\\.descriptionColor===void 0&&\\([^)]*\\),`
  + 'color:\\4\\.isOptionDisabled\\?\\4\\.option\\.descriptionColor:\\4\\.isSelected\\?"success":'
  + '\\4\\.isFocused\\?"suggestion":\\4\\.option\\.descriptionColor,'
  + `children:${IDENT}\\(${IDENT},\\{children:\\4\\.option\\.description\\|\\|" "\\}\\)\\}\\)`,
  'g',
);

function outcome(content: string, status: PatchSiteResult['status'], extra?: string) {
  const result = extra === undefined ? { status, name: NAME } : { status, name: NAME, extra };
  return { content, result };
}

export function applySelectBadge(source: string) {
  if (source.includes(MARKER)) return outcome(source, 'SKIP', 'already applied');
  const matches = [...source.matchAll(DESCRIPTION_CELL)];
  if (matches.length !== 1) {
    return outcome(source, 'SKIP', `description cell anchor matched ${matches.length} times`);
  }
  return outcome(insertBadge(source, matches[0] as RegExpExecArray), 'OK');
}

function insertBadge(source: string, match: RegExpExecArray): string {
  const [cell, head = '', createElement, text, row] = match;
  const description = cell.slice(head.length);
  const badge = `${row}.option.badge&&${createElement}(${text},{color:"${BADGE_COLOR}",children:[${row}.option.badge," "]})`;
  const end = match.index + cell.length;
  return source.slice(0, match.index) + `${head}[${MARKER}${badge},${description}]` + source.slice(end);
}
