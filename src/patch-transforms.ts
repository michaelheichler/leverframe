
import { applyRoutingNoticeTransform } from './patch-transforms-routing-notice.js';

export const PATCH_TRANSFORMS_VERSION = 5;

export interface PatchScriptModelEntry {
  alias?: string;
  context?: number;

  display?: string;

  effort?: PatchScriptEffort;
}

export interface PatchScriptEffort {
  levels: string[];
  defaultLevel: string;
}

export type PatchScriptModelConfig = Record<string, PatchScriptModelEntry>;

const RESERVED_MODEL_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable', 'opusplan', 'best', 'default']);

const NATIVE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const BASE_EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

export function projectNativeEffort(effort: PatchScriptEffort | undefined): PatchScriptEffort | undefined {
  if (!effort || !Array.isArray(effort.levels) || typeof effort.defaultLevel !== 'string') return undefined;
  const declared = new Set(effort.levels);
  if (!BASE_EFFORT_LEVELS.every(level => declared.has(level))) return undefined;
  const levels = NATIVE_EFFORT_LEVELS.filter(level => declared.has(level));

  if (!levels.some(level => level === effort.defaultLevel)) return undefined;
  return { levels, defaultLevel: 'high' };
}

export type PatchSiteStatus = 'OK' | 'SKIP' | 'FAIL';

export interface PatchSiteResult {
  status: PatchSiteStatus;
  name: string;
  extra?: string;
}

export interface ApplyPatchesOutcome {

  content: string;

  results: PatchSiteResult[];
}

export class PatchApplyError extends Error {
  readonly results: PatchSiteResult[];
  constructor(message: string, results: PatchSiteResult[]) {
    super(message);
    this.name = 'PatchApplyError';
    this.results = results;
  }
}

export function formatPatchSiteLine(result: PatchSiteResult): string {
  return '  ' + result.status.padEnd(4) + ' ' + result.name + (result.extra ? ': ' + result.extra : '');
}

export function applyLeverframePatches(source: string, config: PatchScriptModelConfig): ApplyPatchesOutcome {
  let js = source;
  const MODEL_CONFIG = config;

  const ALIAS_TO_ID: Record<string, string> = Object.create(null) as Record<string, string>;

  const IDENTITIES: string[] = [];

  const DISPLAY_BY_IDENTITY: Record<string, string> = Object.create(null) as Record<string, string>;

  const CONTEXT_BY_KEY: Record<string, number> = Object.create(null) as Record<string, number>;

  const CONFIGURED_CAPABILITY_KEYS = new Set<string>();

  const EFFORT_BY_KEY: Record<string, PatchScriptEffort> = Object.create(null) as Record<string, PatchScriptEffort>;
  const ALIAS_OWNERS = new Map<string, string>();

  const report: PatchSiteResult[] = [];
  const fail = (message: string): never => {
    throw new PatchApplyError(message, report);
  };

  const capabilityKeys = (value: string): string[] => {
    const normalized = String(value).trim().toLowerCase();
    const bare = normalized.replace(/\[1m\]$/i, '');
    return [...new Set([bare, bare + '[1m]'])];
  };

  for (const [id, value] of Object.entries(MODEL_CONFIG)) {
    const spec: PatchScriptModelEntry = value && typeof value === 'object' ? value : { alias: value as unknown as string };
    if (spec.alias !== undefined) {
      const a = String(spec.alias).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]*(\[1m\])?$/.test(a)) {
        fail('leverframe patch: alias "' + spec.alias + '" is not a safe lowercase alias');
      }
      if (RESERVED_MODEL_ALIASES.has(a.replace(/\[1m\]$/i, ''))) {
        fail('leverframe patch: reserved alias "' + a + '" cannot be reassigned');
      }
      const existingOwner = ALIAS_OWNERS.get(a);
      if (existingOwner !== undefined) {
        fail('leverframe patch: duplicate alias "' + a + '" for "' + existingOwner + '" and "' + id + '"');
      }
      ALIAS_OWNERS.set(a, String(id));
      ALIAS_TO_ID[a] = String(id);
      IDENTITIES.push(a);
      if (spec.display) DISPLAY_BY_IDENTITY[a] = String(spec.display);
    } else {
      IDENTITIES.push(String(id));
      if (spec.display) DISPLAY_BY_IDENTITY[String(id)] = String(spec.display);
    }
    for (const key of capabilityKeys(spec.alias !== undefined ? String(spec.alias) : String(id))) {
      CONFIGURED_CAPABILITY_KEYS.add(key);
    }
    for (const key of capabilityKeys(String(id))) {
      CONFIGURED_CAPABILITY_KEYS.add(key);
    }

    if (spec.context !== undefined) {
      const n = Number(spec.context);
      if (!Number.isInteger(n) || n <= 0) {
        fail('leverframe patch: context for "' + id + '" must be a positive integer, got ' + spec.context);
      }

      if (/\[1m\]/i.test(String(spec.alias ?? '')) || /\[1m\]/i.test(id)) {
        fail(
          'leverframe patch: "' + id + '" sets context but keeps the [1m] suffix: drop the suffix from both the id and the alias'
        );
      }
      if (spec.alias !== undefined) CONTEXT_BY_KEY[String(spec.alias).trim().toLowerCase()] = n;
      CONTEXT_BY_KEY[String(id).trim().toLowerCase()] = n;
    }

    if (spec.effort !== undefined) {
      const projected = projectNativeEffort(spec.effort);
      if (!projected) {
        return fail(
          'leverframe patch: effort for "' + id + '" must declare at least low/medium/high with a declared default level'
        );
      }

      const keys = capabilityKeys(spec.alias !== undefined ? String(spec.alias) : String(id));
      for (const key of keys) {
        EFFORT_BY_KEY[key] = projected;
      }
      if (spec.alias !== undefined) {
        for (const key of capabilityKeys(String(id))) {
          EFFORT_BY_KEY[key] = projected;
        }
      }
    }
  }
  const ALIASES = Object.keys(ALIAS_TO_ID);
  const MODELS = Object.keys(MODEL_CONFIG);
  if (MODELS.length === 0) fail('leverframe patch: MODEL_CONFIG is empty');

  function displayFor(identity: string, fallbackId: string): string {
    return DISPLAY_BY_IDENTITY[identity] || 'Custom model (' + fallbackId + ')';
  }

  const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const q = (s: string) => JSON.stringify(s);

  function log(status: PatchSiteStatus, name: string, extra?: string) {
    report.push(extra === undefined ? { status, name } : { status, name, extra });
  }

  function applyOnce(
    name: string,
    regex: RegExp,
    fn: (match: string, ...groups: string[]) => string,
    { marker, required, noopIsSkip }: { marker?: string; required?: boolean; noopIsSkip?: boolean } = {},
  ): void {
    if (marker && js.includes(marker)) { log('SKIP', name, 'already patched'); return; }
    const g = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    const matches = js.match(g);
    const count = matches ? matches.length : 0;
    if (count === 0) {
      log('FAIL', name, 'anchor not found');
      if (required) fail('leverframe patch: required patch failed: ' + name);
      return;
    }
    if (count > 1) {
      log('FAIL', name, 'anchor matched ' + count + ' times (expected 1)');
      if (required) fail('leverframe patch: ambiguous anchor: ' + name);
      return;
    }
    const before = js;
    js = js.replace(regex, fn as (substring: string, ...args: unknown[]) => string);
    if (js === before) {

      if (noopIsSkip) { log('SKIP', name, 'already patched'); return; }
      log('FAIL', name, 'replacement made no change');
      if (required) fail(name);
      return;
    }
    log('OK', name);
  }

  function extendAliasArray(arrLiteral: string): string {
    const toAdd = IDENTITIES.filter((a) => !new RegExp('"' + reEsc(a) + '"').test(arrLiteral));
    if (toAdd.length === 0) return arrLiteral;
    return arrLiteral.replace(/\]\s*$/, ',' + toAdd.map(q).join(',') + ']');
  }

  applyOnce(
    'PATCH 1: Agent tool model enum',
    /((?:\.enum|:[A-Za-z_$][\w$]*)\()(\["sonnet","opus","haiku","fable"(?:,"[^"]+")*\])(\)\.optional\(\)\.describe\(`Optional model override for this agent)/,
    (_m, constructorHead, arr, descriptionHead) => constructorHead! + extendAliasArray(arr!) + descriptionHead!,
    { required: true, noopIsSkip: true }
  );

  applyOnce(
    'PATCH 3: known-alias validator list',
    /\["sonnet","opus","haiku","fable"(?:,"[^"]+")*,"opusplan"(?:,"[^"]+")*\]/,
    (m) => extendAliasArray(m),
    { required: true, noopIsSkip: true }
  );

  {
    const RESUME_MODEL_MARKER = '/*ccpatch:resume-model*/';
    const RESUME_MODEL_NAME = 'PATCH 11: session-restore model family allowlist';
    if (!js.includes('?"unknown_family":')) {
      log('SKIP', RESUME_MODEL_NAME, 'not present in this Claude Code version');
    } else {
      applyOnce(
        RESUME_MODEL_NAME,
        /!\(([\w$]+)\.has\(([\w$]+)\(([\w$]+)\)\)\|\|([\w$]+)\(\3\)\|\|([\w$]+)\(\3\)===([\w$]+)\)\?"unknown_family":!([\w$]+)\(\3\)&&!([\w$]+)\(\3\)\?"not_allowed":([\w$]+)\(\3\)\?"retired":void 0;/,
        (_m, r, Eo, a, tJe, dd, o, Ek, vc, ypr) =>
          `!(${r!}.has(${Eo!}(${a!}))||${tJe!}(${a!})||${dd!}(${a!})===${o!}||${RESUME_MODEL_MARKER}${vc!}(${a!}))?"unknown_family":!${Ek!}(${a!})&&!${vc!}(${a!})?"not_allowed":${ypr!}(${a!})?"retired":void 0;`,
        { marker: RESUME_MODEL_MARKER, required: false }
      );
    }
  }

  {
    const missing = ALIASES.filter((a) => !new RegExp('case' + reEsc(q(a)) + ':return').test(js));
    const cases = missing.map((a) => 'case' + q(a) + ':return ' + q(a) + ';').join('');
    if (ALIASES.length === 0) {
      log('SKIP', 'PATCH 6: alias resolver switch', 'no aliases configured');
    } else {
      applyOnce(
        'PATCH 6: alias resolver switch',
        /(case"best":\{[^{}]*\})/,
        (m) => m + cases,
        { required: true, noopIsSkip: true }
      );
    }
  }

  {
    const missing = ALIASES.filter((a) => !new RegExp('value:' + reEsc(q(a))).test(js));
    const entries = missing
      .map(

        (a) => '{value:' + q(a) + ',label:' + q(a.charAt(0).toUpperCase() + a.slice(1)) + ',description:' + q(displayFor(a, ALIAS_TO_ID[a]!)) + '}'
      )
      .join(',');
    const inject = missing.length
      ? '[' + entries + '].forEach(function(_o){if(!e.some(function(_i){return _i.value===_o.value}))e.push(_o)});'
      : '';
    if (ALIASES.length === 0) {
      log('SKIP', 'PATCH 5: model picker options', 'no aliases configured');
    } else {
      applyOnce(
        'PATCH 5: model picker options',
        /(\?\[[\w$]+,r\]:\[r\];for\(let [\w$]+ of [\w$]+\)[\w$]+\(e,[\w$]+,t\);)/,
        (m) => m + inject,
        { required: false, noopIsSkip: true }
      );
    }
  }

  {
    const safe = (s: string) => String(s).replace(/`/g, "'").replace(/\$\{/g, '(');
    const listing = IDENTITIES.map(function (i) {
      const d = DISPLAY_BY_IDENTITY[i];
      return d ? safe(i) + ' = ' + safe(d) : safe(i);
    }).join('; ');
    applyOnce(
      'PATCH 4: Agent tool model description',
      /(describe\(`Optional model override for this agent[^`]*?)(`\))/,
      (_m, body, close) =>
        body!.includes('Additional custom models')
          ? body! + close!
          : body! + ' Additional custom models: ' + listing + '.' + close!,
      { required: false, noopIsSkip: true }
    );
  }

  if (Object.keys(CONTEXT_BY_KEY).length) {
    const MARKER = '/*ccpatch:ctx*/';
    const contextTable = JSON.stringify(CONTEXT_BY_KEY);
    const contextLookup = 'Object.assign(Object.create(null),JSON.parse(' + JSON.stringify(contextTable) + '))';
    const SNIPPET =
      MARKER + 'var _ccw=' + contextLookup + '[String(e||"").trim().toLowerCase()];if(_ccw!==void 0)return _ccw;';

    if (js.includes(MARKER)) {

      applyOnce(
        'PATCH 7: per-model context window (refresh)',
          /\/\*ccpatch:ctx\*\/var _ccw=(?:\(\{[^{}]*\}\)|Object\.assign\(Object\.create\(null\),JSON\.parse\("(?:[^"\\]|\\.)*"\)\))\[[^\]]*\];if\(_ccw!==void 0\)return _ccw;/,
        () => SNIPPET,
        { required: true, noopIsSkip: true }
      );
    } else {
      applyOnce(
        'PATCH 7: per-model context window',
        /(function [\w$]+\(e,t\)\{)(let [\w$]+=[\w$]+\(\);if\([\w$]+!==void 0\)return [\w$]+;if\([\w$]+\(e,t\)\)return [\w$]+;return [\w$]+\(e,t\)\})/,
        (_m, head, body) => head! + SNIPPET + body!,
        { required: true }
      );
    }
  }

  if (Object.keys(EFFORT_BY_KEY).length) {
    patchEffortCapabilitySite(
      'effort',
      '/*ccpatch:effort*/',
      'PATCH 8a: effort capability',
      /(function [\w$]+\(([\w$]+)\)\{if\([\w$]+\(\2\)\)return!1;)(let [\w$]+=[\w$]+\(\2,"effort"\);)/,
    );
    patchEffortCapabilitySite(
      'xhigh_effort',
      '/*ccpatch:xhigh-effort*/',
      'PATCH 8b: xhigh effort capability',
      /(function [\w$]+\(([\w$]+)\)\{if\([\w$]+\(\2\)\)return!1;)(let [\w$]+=[\w$]+\(\2,"xhigh_effort"\);)/,
    );
    patchEffortCapabilitySite(
      'max_effort',
      '/*ccpatch:max-effort*/',
      'PATCH 8c: max effort capability',
      /(function [\w$]+\(([\w$]+)\)\{if\([\w$]+\(\2\)\)return!1;)(let [\w$]+=[\w$]+\(\2,"max_effort"\);)/,
    );
  }

  if (Object.keys(EFFORT_BY_KEY).length) {
    const DEFAULT_EFFORT_MARKER = '/*ccpatch:default-effort*/';
    const defaults = Object.fromEntries(
      Object.entries(EFFORT_BY_KEY).map(([key, effort]) => [key, effort.defaultLevel]),
    );
    const snippet = (arg: string) =>
      DEFAULT_EFFORT_MARKER
      + 'var _cce=Object.assign(Object.create(null),' + JSON.stringify(defaults)
      + ')[String(' + arg + '||"").trim().toLowerCase()];'
      + 'if(_cce!==void 0)return _cce;';

    if (js.includes(DEFAULT_EFFORT_MARKER)) {
      applyOnce(
        'PATCH 9: default effort (refresh)',
        /\/\*ccpatch:default-effort\*\/var _cce=Object\.assign\(Object\.create\(null\),\{[^{}]*\}\)\[String\(([\w$]+)\|\|""\)\.trim\(\)\.toLowerCase\(\)\];if\(_cce!==void 0\)return _cce;/,
        (_m, arg) => snippet(arg!),
        { required: true, noopIsSkip: true },
      );
    } else {
      applyOnce(
        'PATCH 9: default effort',
        /(function [\w$]+\(([\w$]+)\)\{)(return [\w$]+\([\w$]+\(\2\)\)\?\.default_effort\?\?"high"\})/,
        (_m, head, arg, body) => head! + snippet(arg!) + body!,
        { required: true },
      );
    }
  }

  const routingNotice = applyRoutingNoticeTransform(js, MODEL_CONFIG);
  js = routingNotice.content;
  report.push(...routingNotice.results);
  return { content: js, results: report };

  function patchEffortCapabilitySite(
    capability: 'effort' | 'xhigh_effort' | 'max_effort',
    marker: string,
    name: string,
    anchor: RegExp,
  ): void {
    const verdicts = Object.fromEntries(
      [...CONFIGURED_CAPABILITY_KEYS].map(key => {
        const effort = EFFORT_BY_KEY[key];
        const grants = effort !== undefined && (
          capability === 'effort'
          || effort.levels.includes(capability === 'xhigh_effort' ? 'xhigh' : 'max')
        );
        return [key, grants];
      }),
    );
    const snippet = (arg: string) =>
      marker
      + 'var _ccv=Object.assign(Object.create(null),' + JSON.stringify(verdicts)
      + ')[String(' + arg + '||"").trim().toLowerCase()];'
      + 'if(_ccv!==void 0)return _ccv;';

    if (js.includes(marker)) {
      applyOnce(
        name + ' (refresh)',
        new RegExp(
          reEsc(marker)
          + 'var _ccv=Object\\.assign\\(Object\\.create\\(null\\),\\{[^{}]*\\}\\)'
          + '\\[String\\(([\\w$]+)\\|\\|""\\)\\.trim\\(\\)\\.toLowerCase\\(\\)\\];'
          + 'if\\(_ccv!==void 0\\)return _ccv;',
        ),
        (_m, arg) => snippet(arg!),
        { required: true, noopIsSkip: true },
      );
      return;
    }

    applyOnce(
      name,
      anchor,
      (_m, head, arg, body) => head! + snippet(arg!) + body!,
      { required: true },
    );
  }
}
