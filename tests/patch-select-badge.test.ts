import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { applySelectBadge } from '../src/patch-select-badge.js';

type SelectIdentifiers = {
  element: string;
  box: string;
  text: string;
  row: string;
  inline: string;
};

type RenderedNode = {
  type: string;
  props: Record<string, unknown>;
};

function descriptionCell(names: SelectIdentifiers): string {
  const { element, box, text, row, inline } = names;
  return `${element}(${box},{flexGrow:1,marginLeft:2,children:${element}(${text},{wrap:"wrap",dimColor:${row}.option.descriptionColor===void 0&&(${row}.isOptionDisabled||${row}.option.dimDescription!==!1),color:${row}.isOptionDisabled?${row}.option.descriptionColor:${row}.isSelected?"success":${row}.isFocused?"suggestion":${row}.option.descriptionColor,children:${element}(${inline},{children:${row}.option.description||" "})})})`;
}

function renderCell(source: string, option: { description: string; badge?: string }): RenderedNode {
  const element = (type: string, props: Record<string, unknown>): RenderedNode => ({ type, props });
  const row = { option, isOptionDisabled: false, isSelected: false, isFocused: false };
  return runInNewContext(source, {
    e: element, s: 'Box', n: 'Text', ls: 'Inline', me: row,
    jsx: element, $Box: 'Box', _Text: 'Text', item: row, Inline: 'Inline',
  }) as RenderedNode;
}

const ORIGINAL_IDENTIFIERS: SelectIdentifiers = { element: 'e', box: 's', text: 'n', row: 'me', inline: 'ls' };
const RENAMED_IDENTIFIERS: SelectIdentifiers = { element: 'jsx', box: '$Box', text: '_Text', row: 'item', inline: 'Inline' };

describe('Select option badge rendering', () => {
  it.each([ORIGINAL_IDENTIFIERS, RENAMED_IDENTIFIERS])(
    'renders a themed badge before the unchanged description with $element identifiers', names => {
      const source = descriptionCell(names);
      const option = { description: 'Provider model description', badge: 'API' };
      const original = renderCell(source, option);

      const patched = applySelectBadge(source);

      expect(patched.result.status).toBe('OK');
      const rendered = renderCell(patched.content, option);
      expect(rendered).toEqual({
        ...original,
        props: {
          ...original.props,
          children: [
            { type: 'Text', props: { color: 'autoAccept', children: [option.badge, ' '] } },
            original.props.children,
          ],
        },
      });
    },
  );

  it('renders only the original description when the option has no badge', () => {
    const source = descriptionCell(ORIGINAL_IDENTIFIERS);
    const option = { description: 'Subscription model description' };
    const original = renderCell(source, option);

    const patched = applySelectBadge(source);

    expect(patched.result.status).toBe('OK');
    const rendered = renderCell(patched.content, option);
    expect([rendered.props.children].flat().filter(Boolean)).toEqual([original.props.children]);
  });
});

describe('Select option badge patch safety', () => {
  it('leaves the bundle unchanged when the badge patch is applied again', () => {
    const firstPass = applySelectBadge(descriptionCell(ORIGINAL_IDENTIFIERS));

    const secondPass = applySelectBadge(firstPass.content);

    expect(secondPass.result.status).toBe('SKIP');
    expect(secondPass.content).toBe(firstPass.content);
  });

  it.each([
    { label: 'missing', source: 'var unrelatedPicker=true;' },
    {
      label: 'ambiguous',
      source: `${descriptionCell(ORIGINAL_IDENTIFIERS)};${descriptionCell(ORIGINAL_IDENTIFIERS)}`,
    },
  ])('skips a $label description cell without changing the bundle', ({ source }) => {
    const patched = applySelectBadge(source);

    expect(patched.result.status).toBe('SKIP');
    expect(patched.content).toBe(source);
  });
});
