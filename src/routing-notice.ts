// Why: Keep routing notice formatting independent from terminal styling.

export type RoutingNoticeSegment = {
  text: string;
  color?: 'success' | 'suggestion';
  bold?: true;
};

export const ROUTING_NOTICE_MARKER = '/*ccpatch:routing-notice*/';

function normalize(value: string | number): string {
  return String(value).trim().replace(/\s+/g, ' ');
}

/** Because downstream presenters require a canonical representation. */
export function formatRoutingNotice(input: {
  modelDisplay: string;
  effort: string | number;
}): { text: string; segments: RoutingNoticeSegment[] } {
  const modelDisplay = normalize(input.modelDisplay);
  const effort = normalize(input.effort);
  const segments: RoutingNoticeSegment[] = [
    { text: 'Routing successful. Model ' },
    { text: modelDisplay, color: 'suggestion', bold: true },
    { text: ' with Reasoning ' },
    { text: effort, color: 'success', bold: true },
  ];

  return { text: segments.map((segment) => segment.text).join(''), segments };
}
