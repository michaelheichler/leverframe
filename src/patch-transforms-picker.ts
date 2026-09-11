import type { PatchSiteResult } from './patch-transforms.js';
import { ONE_M_CONTEXT_WINDOW } from './context-model-id.js';

export interface NativeContextMode {
  default: number;
  maximum?: number;
}

export type NativeContextModes = Record<string, NativeContextMode>;

export interface NativeContextPickerOutcome {
  content: string;
  result: PatchSiteResult;
}

const PATCH_COMMENT_START = '/' + '*';
const PATCH_COMMENT_END = '*' + '/';
const PATCH_NAME = 'PATCH 12: context mode picker';
const PATCH_MARKER = PATCH_COMMENT_START + 'ccpatch:context-mode-picker' + PATCH_COMMENT_END;
const CONTEXT_ROW_BASE_HELPER =
  'const __lfcBaseModel=function(value){return typeof value==="string"?value.replace(/(?:\\[(?:default|maximum|1m)\\])+$/i,""):value;};';
const LEGACY_PICKER_ENV = [
  'const base=typeof process==="object"&&process&&process.env?process.env.ANTHROPIC_BASE_URL:void 0;',
  'const token=typeof process==="object"&&process&&process.env?process.env.ANTHROPIC_API_KEY:void 0;',
].join('');
const CURRENT_PICKER_ENV = [
  'const configuredBase=typeof process==="object"&&process&&process.env?process.env.LEVERFRAME_CONTEXT_SELECTION_BASE_URL:void 0;',
  'const configuredToken=typeof process==="object"&&process&&process.env?process.env.LEVERFRAME_CONTEXT_SELECTION_TOKEN:void 0;',
  'const baseValue=typeof configuredBase==="string"&&configuredBase.trim()!==""?configuredBase:typeof process==="object"&&process&&process.env?process.env.ANTHROPIC_BASE_URL:void 0;',
  'const base=typeof baseValue==="string"?baseValue.trim():void 0;',
  'const token=typeof configuredToken==="string"&&configuredToken.length>0?configuredToken:typeof process==="object"&&process&&process.env?process.env.ANTHROPIC_API_KEY:void 0;',
].join('');

interface PickerShape {
  functionStart: number;
  bodyStart: number;
  select: string;
}

interface RendererShape {
  createElement: string;
  component: string;
}

function result(status: PatchSiteResult['status'], extra?: string): PatchSiteResult {
  return extra === undefined
    ? { status, name: PATCH_NAME }
    : { status, name: PATCH_NAME, extra };
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patchOnce(
  source: string,
  regex: RegExp,
  replacement: (match: string, ...groups: string[]) => string,
  opts: { noopIsSkip?: boolean } = {},
): { content: string; result: PatchSiteResult } {
  const global = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  const matches = source.match(global);
  const count = matches?.length ?? 0;
  if (count === 0) return { content: source, result: result('FAIL', 'anchor not found') };
  if (count > 1) return { content: source, result: result('FAIL', 'anchor matched ' + count + ' times (expected 1)') };
  const content = source.replace(regex, replacement as (substring: string, ...args: unknown[]) => string);
  return content === source
    ? {
      content: source,
      result: result(opts.noopIsSkip ? 'SKIP' : 'FAIL', opts.noopIsSkip ? 'already patched' : 'replacement made no change'),
    }
    : { content, result: result('OK') };
}

interface OptionalPatchOutcome {
  content: string;
  result: PatchSiteResult;
  fatal: boolean;
}

function patchOptional(
  source: string,
  regex: RegExp,
  replacement: (match: string, ...groups: string[]) => string,
): OptionalPatchOutcome {
  const outcome = patchOnce(source, regex, replacement);
  const missing = outcome.result.status === 'FAIL' && outcome.result.extra === 'anchor not found';
  return {
    content: missing ? source : outcome.content,
    result: outcome.result,
    fatal: outcome.result.status === 'FAIL' && !missing,
  };
}

const NORMALIZE_OPTIONS_PATTERN = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\(\)=>(([A-Za-z_$][\w$]*)\?\?([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)),(\[[^\]]*\])\)/;
const SELECTED_VALUE_PATTERN = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)===null\?([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\2\)\?\?\2([,;])/;
const CONTEXT_ROWS_PATTERN = /if\(([A-Za-z_$][\w$]*)!==null&&!([A-Za-z_$][\w$]*)\.some\(\(([A-Za-z_$][\w$]*)\)=>\3\.value===([A-Za-z_$][\w$]*)\)&&!([A-Za-z_$][\w$]*)\.some\(\(([A-Za-z_$][\w$]*)\)=>\6\.value===\1\)&&([A-Za-z_$][\w$]*)\(\1\)\)/;
const SELECTED_MODEL_PATTERN = /([A-Za-z_$][\w$]*)\.some\(\(([A-Za-z_$][\w$]*)\)=>\2\.value===([A-Za-z_$][\w$]*)\.value\)\?\3\.value:\1\[0\]\?\.value\?\?\s*void 0/;

function replaceNormalizedOptions(_match: string, ...groups: string[]): string {
  const [options, memo, _expression, preferred, fallback, argument, dependencies] = groups;
  return options! + '=' + memo! + '(()=>__lfcNormalizeContextOptions(' + preferred! + '??' + fallback! + '(' + argument! + ')),' + dependencies! + ')';
}

function replaceSelectedValue(_match: string, ...groups: string[]): string {
  const [selected, current, noPreference, resolveModel, options, terminator] = groups;
  return selected! + '=' + current! + '===null?' + noPreference! + ':'
    + options! + '.find((option)=>__lfcContextIdentity(option.value)===__lfcContextIdentity(' + resolveModel! + '(' + options! + ',' + current! + ')))?.value??'
    + options! + '.find((option)=>__lfcContextIdentity(option.value)===__lfcContextIdentity(' + current! + '))?.value??'
    + resolveModel! + '(' + options! + ',' + current! + ')??' + current! + terminator!;
}

function replaceContextRows(_match: string, ...groups: string[]): string {
  const [current, options, option, selected, extra, extraOption, isRoutable] = groups;
  return 'if(' + current! + '!==null&&!'+ options! + '.some((' + option! + ')=>' + option! + '.value===' + selected!
    + '||(__lfcContextIdentity(' + option! + '.value)===__lfcContextIdentity(' + selected! + ')))&&!'
    + extra! + '.some((' + extraOption! + ')=>' + extraOption! + '.value===' + current!
    + '||(__lfcContextIdentity(' + extraOption! + '.value)===__lfcContextIdentity(' + current! + ')))&&'
    + isRoutable! + '(' + current! + '))';
}

function replaceSelectedModel(_match: string, ...groups: string[]): string {
  const [options, option, selected] = groups;
  return options! + '.find((' + option! + ')=>' + option! + '.value===' + selected! + '.value'
    + '||(__lfcContextIdentity(' + option! + '.value)===__lfcContextIdentity(' + selected! + '.value)))?.value??'
    + options! + '[0]?.value??void 0';
}

function findProperty(params: string, property: string): string | undefined {
  const match = new RegExp(
    '(?:^|,)\\s*' + escaped(property) + '\\s*:\\s*([A-Za-z_$][\\w$]*)',
  ).exec(params);
  return match?.[1];
}

function pickerModelKeys(key: string): string[] {
  const normalized = key.trim().toLowerCase();
  if (!normalized.startsWith('leverframe:')) return [normalized];
  const target = normalized.slice('leverframe:'.length);
  const separator = target.indexOf(':');
  if (separator <= 0 || separator === target.length - 1) return [normalized];
  const provider = target.slice(0, separator).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const model = target.slice(separator + 1);
  const alias = model.startsWith('claude-') ? model : `anthropic-${provider}__${model}`;
  return [...new Set([normalized, alias])];
}

function findPicker(source: string): PickerShape[] {
  const pattern = /function\s+[A-Za-z_$][\w$]*\s*\(\{([^{}]*)\}\)\s*\{/g;
  const candidates: PickerShape[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const params = match[1]!;
    if (
      findProperty(params, 'initial') === undefined
      || findProperty(params, 'sessionModel') === undefined
      || findProperty(params, 'onSetDefault') === undefined
      || findProperty(params, 'onCancel') === undefined
      || findProperty(params, 'options') === undefined
    ) continue;
    const select = findProperty(params, 'onSelect');
    if (select === undefined) continue;
    candidates.push({ functionStart: match.index, bodyStart: pattern.lastIndex, select });
  }
  return candidates;
}

interface CodeCharacter {
  char: string;
  index: number;
}

function* scanCodeCharacters(source: string, start = 0): Generator<CodeCharacter> {
  let quote: 'single' | 'double' | 'template' | undefined;
  for (let index = start; index < source.length; index++) {
    const char = source[index]!;
    if (quote !== undefined) {
      if (char === '\\') index++;
      else if (
        (quote === 'single' && char === "'")
        || (quote === 'double' && char === '"')
        || (quote === 'template' && char === '`')
      ) quote = undefined;
      continue;
    }
    if (char === "'") { quote = 'single'; continue; }
    if (char === '"') { quote = 'double'; continue; }
    if (char === '`') { quote = 'template'; continue; }
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      index = newline === -1 ? source.length : newline;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      index = close === -1 ? source.length : close + 1;
      continue;
    }
    yield { char, index };
  }
}

export function findBalancedBlockEnd(source: string, bodyStart: number): number | undefined {
  let depth = 1;
  for (const { char, index } of scanCodeCharacters(source, bodyStart)) {
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return index;
  }
  return undefined;
}

function findRenderer(body: string): RendererShape[] {
  const pattern = /\b([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*\{/g;
  const candidates: RendererShape[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const objectStart = match.index + match[0].length;
    const objectEnd = findBalancedBlockEnd(body, objectStart);
    if (objectEnd === undefined) continue;
    const object = body.slice(objectStart, objectEnd);
    if (
      hasTopLevelProperty(object, 'options')
      && hasTopLevelProperty(object, 'onChange')
      && hasTopLevelProperty(object, 'onCancel')
    ) {
      candidates.push({ createElement: match[1]!, component: match[2]! });
    }
  }
  return candidates;
}

function hasTopLevelProperty(object: string, property: string): boolean {
  let curly = 0;
  let square = 0;
  let paren = 0;
  for (const { char, index } of scanCodeCharacters(object)) {
    if (curly === 0 && square === 0 && paren === 0) {
      const propertyPattern = new RegExp('^' + escaped(property) + '\\s*:').exec(object.slice(index));
      if (propertyPattern) return true;
    }
    if (char === '{') curly++;
    else if (char === '}') curly--;
    else if (char === '[') square++;
    else if (char === ']') square--;
    else if (char === '(') paren++;
    else if (char === ')') paren--;
  }
  return false;
}

function invalid(detail: string, nativeBundleSource: boolean, source: string): NativeContextPickerOutcome {
  return {
    content: source,
    result: result(nativeBundleSource ? 'FAIL' : 'SKIP', detail),
  };
}

export function applyNativeContextPicker(
  source: string,
  contextModes: NativeContextModes,
  contextAliases: Record<string, string> = {},
): NativeContextPickerOutcome {
  const modelKeys = [...new Set(
    Object.entries(contextModes)
      .filter(([, value]) => Number.isSafeInteger(value.default) && value.default > 0)
      .flatMap(([key]) => pickerModelKeys(key))
      .filter(Boolean),
  )].sort();
  const modelTable = JSON.stringify(Object.fromEntries(modelKeys.map(key => [key, true])));
  const aliasTable = JSON.stringify(Object.fromEntries(
    Object.entries(contextAliases).map(([alias, id]) => [alias.trim().toLowerCase(), String(id).trim().toLowerCase()]),
  ));
  const contextAliasDeclaration = 'const __lfcContextAliases=JSON.parse(' + JSON.stringify(aliasTable) + ');';
  const contextModelDeclaration = 'const __lfcContextModels=JSON.parse(' + JSON.stringify(modelTable) + ');';
  const declaration = PATCH_MARKER + 'var __lfcModels=JSON.parse(' + JSON.stringify(modelTable) + ');';
  const hasCurrentPickerHelpers = (content: string): boolean => [
    'const __lfcContextAliases=',
    'const __lfcContextIdentity=function',
    'const __lfcContextModels=',
    'const __lfcNormalizeContextOptions=function',
    '__lfcNormalizeContextOptions(',
    '__lfcContextIdentity(',
  ].every(marker => content.includes(marker));
  const pristineRebuildRequired = (): NativeContextPickerOutcome => ({
    content: source,
    result: result('FAIL', 'legacy context picker helper is incomplete; rebuild from a pristine Claude Code binary'),
  });

  if (source.includes(PATCH_MARKER)) {
    const declarationUpdate = patchOnce(
      source,
      new RegExp(escaped(PATCH_MARKER) + 'var __lfcModels=JSON\\.parse\\("(?:[^"\\\\]|\\\\.)*"\\);'),
      () => declaration,
      { noopIsSkip: true },
    );
    if (declarationUpdate.result.status === 'FAIL') return declarationUpdate;
    const contextAliasUpdate = patchOnce(
      declarationUpdate.content,
      /const __lfcContextAliases=JSON\.parse\("(?:[^"\\]|\\.)*"\);/,
      () => contextAliasDeclaration,
      { noopIsSkip: true },
    );
    const afterContextAlias = contextAliasUpdate.result.status === 'FAIL' && contextAliasUpdate.result.extra === 'anchor not found'
      ? declarationUpdate.content
      : contextAliasUpdate.content;
    if (contextAliasUpdate.result.status === 'FAIL' && contextAliasUpdate.result.extra !== 'anchor not found') return contextAliasUpdate;
    const contextModelUpdate = patchOnce(
      afterContextAlias,
      /const __lfcContextModels=JSON\.parse\("(?:[^"\\]|\\.)*"\);/,
      () => contextModelDeclaration,
      { noopIsSkip: true },
    );
    const afterContextModels = contextModelUpdate.result.status === 'FAIL' && contextModelUpdate.result.extra === 'anchor not found'
      ? afterContextAlias
      : contextModelUpdate.content;
    if (contextModelUpdate.result.status === 'FAIL' && contextModelUpdate.result.extra !== 'anchor not found') return contextModelUpdate;
    if (afterContextModels.includes('LEVERFRAME_CONTEXT_SELECTION_BASE_URL')) {
      if (!hasCurrentPickerHelpers(afterContextModels)) return pristineRebuildRequired();
      return { content: afterContextModels, result: result('OK') };
    }
    const migration = patchOnce(
      afterContextModels,
      new RegExp(escaped(LEGACY_PICKER_ENV)),
      () => CURRENT_PICKER_ENV,
    );
    if (migration.result.status === 'FAIL') {
      return {
        content: migration.content,
        result: result('FAIL', 'legacy context picker helper could not be migrated'),
      };
    }
    if (!hasCurrentPickerHelpers(migration.content)) return pristineRebuildRequired();
    return migration;
  }

  if (modelKeys.length === 0) {
    return { content: source, result: result('SKIP', 'no maximum context modes configured') };
  }

  const nativeBundleSource =
    source.includes('//#__leverframe_claude_module__:')
    || source.includes('/*__LEVERFRAME_CLAUDE_MODULE_BOUNDARY__*/');
  const pickers = findPicker(source);
  if (pickers.length !== 1) {
    return invalid(
      pickers.length === 0
        ? 'picker prop shape anchor not found'
        : 'picker prop shape anchor matched ' + pickers.length + ' functions',
      nativeBundleSource,
      source,
    );
  }
  const picker = pickers[0]!;
  const bodyEnd = findBalancedBlockEnd(source, picker.bodyStart);
  if (bodyEnd === undefined) return invalid('picker function body could not be delimited', nativeBundleSource, source);
  const body = source.slice(picker.bodyStart, bodyEnd);

  const stateHookMatch = /\[\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*\]\s*=\s*([A-Za-z_$][\w$]*)\s*\(/.exec(body);
  const stateHook = stateHookMatch?.[1];
  if (stateHook === undefined) return invalid('picker state hook anchor not found', nativeBundleSource, source);

  const renderers = findRenderer(body);
  if (renderers.length !== 1) {
    return invalid(
      renderers.length === 0
        ? 'picker renderer anchor not found'
        : 'picker renderer anchor matched ' + renderers.length + ' calls',
      nativeBundleSource,
      source,
    );
  }

  const callbackPattern = new RegExp(
    '\\b' + escaped(picker.select)
    + '\\(([A-Za-z_$][\\w$]*),([A-Za-z_$][\\w$]*)\\)\\}(?=\\s*(?:(?:let|var|const)\\s+[A-Za-z_$][\\w$]*\\s*=|function\\s+[A-Za-z_$][\\w$]*\\s*\\())',
  );
  if (!callbackPattern.test(body)) return invalid('picker selection callback anchor not found', nativeBundleSource, source);

  const names = {
    pending: '__lfcPending',
    setPending: '__lfcSetPending',
    generation: '__lfcGeneration',
    models: '__lfcModels',
    safeOptions: '__lfcSafeOptions',
    remember: '__lfcRememberContext',
    cancel: '__lfcCancelContext',
    commit: '__lfcCommitContext',
    begin: '__lfcBeginContext',
  };
  const helper = [
    declaration,
    'let[' + names.pending + ',' + names.setPending + ']=' + stateHook + '(null);',
    'let __lfcAllowLateRefresh=false;',
    'const ' + names.safeOptions + '=function(value){',
    'if(!Array.isArray(value))return[];',
    'const result=[];',
    'for(const candidate of value){',
    'if(!candidate||typeof candidate!=="object")continue;',
    'const mode=candidate.mode;',
    'const contextWindow=candidate.contextWindow;',
    'const label=candidate.label;',
    'if((mode!=="default"&&mode!=="maximum")||!Number.isSafeInteger(contextWindow)||contextWindow<=0||typeof label!=="string"||label.length===0||label.length>160)continue;',
    'if(result.some(function(item){return item.mode===mode}))continue;',
    'result.push({mode:mode,contextWindow:contextWindow,label:label});',
    '}',
    'result.sort(function(left){return left.mode==="default"?-1:1});',
    'return result;',
    '};',
    'const ' + names.remember + '=function(model,options){',
    'if(typeof globalThis!=="object"||globalThis===null)return;',
    'let __lfcStore=globalThis.__lfcContextWindows;',
    'if(!__lfcStore||typeof __lfcStore!=="object"||Object.getPrototypeOf(__lfcStore)!==null){__lfcStore=Object.create(null);globalThis.__lfcContextWindows=__lfcStore;}',
    'const __lfcModelKey=String(model==null?"":model).trim().toLowerCase().replace(/(?:\\[(?:default|maximum|1m)\\])+$/i,"");',
    'if(__lfcModelKey==="")return;',
    '__lfcStore[__lfcModelKey]=0;',
    '__lfcStore[__lfcModelKey+"[default]"]=0;',
    '__lfcStore[__lfcModelKey+"[maximum]"]=0;',
    '__lfcStore[__lfcModelKey+"[1m]"]=0;',
    'for(const __lfcOption of options){',
    '__lfcStore[__lfcModelKey+"["+__lfcOption.mode+"]"]=__lfcOption.contextWindow;',
    'if(__lfcOption.mode==="default"||__lfcStore[__lfcModelKey]===0)__lfcStore[__lfcModelKey]=__lfcOption.contextWindow;',
    'if(__lfcOption.contextWindow>=' + ONE_M_CONTEXT_WINDOW + '&&__lfcStore[__lfcModelKey+"[1m]"]===0)__lfcStore[__lfcModelKey+"[1m]"]=__lfcOption.contextWindow;',
    '}',
    '};',
    'const ' + names.cancel + '=function(){' + names.generation + '++;__lfcAllowLateRefresh=true;' + names.setPending + '(null);};',
    'const ' + names.commit + '=function(model,effort,option){',
    'if(!option||(option.mode!=="default"&&option.mode!=="maximum"))return;',
    'const __lfcModelKey=String(model==null?"":model).trim().replace(/(?:\\[(?:default|maximum|1m)\\])+$/i,"");',
    'if(__lfcModelKey==="")return;',
    '__lfcAllowLateRefresh=false;' + names.generation + '++;' + names.setPending + '(null);',
    names.remember + '(__lfcModelKey,[option]);',
    picker.select + '(option.mode==="maximum"?__lfcModelKey+"[maximum]":__lfcModelKey,effort);',
    '};',
    'const ' + names.begin + '=function(model,effort){',
    '__lfcAllowLateRefresh=false;',
    'const __lfcModelKey=String(model==null?"":model).trim().replace(/(?:\\[(?:default|maximum|1m)\\])+$/i,"");',
    'const key=__lfcModelKey.toLowerCase();',
    'if(!Object.prototype.hasOwnProperty.call(' + names.models + ',key))return false;',
    'const generation=++' + names.generation + ';',
    names.setPending + '({status:"loading",model:__lfcModelKey,effort:effort});',
    CURRENT_PICKER_ENV,
    'if(typeof base!=="string"||!/^http:\\/\\/127\\.0\\.0\\.1(?::\\d+)?(?:\\/|$)/.test(base)||typeof token!=="string"||token.length===0){',
    names.setPending + '({status:"error",model:__lfcModelKey,effort:effort});return true;',
    '}',
    'let endpoint;',
    'try{endpoint=new URL("/v1/leverframe/context-selection",base)}catch{' + names.setPending + '({status:"error",model:__lfcModelKey,effort:effort});return true}',
    'endpoint.searchParams.set("model",__lfcModelKey);',
    'fetch(endpoint,{headers:{Authorization:"Bearer "+token},redirect:"error"}).then(function(response){if(!response.ok)throw new Error("context discovery failed");return response.json()}).then(function(payload){',
    'const options=' + names.safeOptions + '(payload&&payload.options);',
    'const current=generation===' + names.generation + ';',
    'if(current||__lfcAllowLateRefresh)' + names.remember + '(__lfcModelKey,options);',
    'if(!current)return;',
    'if(options.length===0)throw new Error("no confirmed context options");',
    'if(options.length===1){' + names.commit + '(__lfcModelKey,effort,options[0]);return;}',
    names.setPending + '({status:"ready",model:__lfcModelKey,effort:effort,options:options});',
    '}).catch(function(){if(generation===' + names.generation + ')' + names.setPending + '({status:"error",model:__lfcModelKey,effort:effort});});',
    'return true;',
    '};',
  ].join('');
  const renderer = renderers[0]!;
  const renderBranch =
    'if(' + names.pending + '!==null){'
    + 'const displayOptions=' + names.pending + '.status==="ready"?'
    + names.pending + '.options.map(function(option){return{value:option.mode,label:option.label}}):'
    + '[{value:"__leverframe_context_status",label:' + names.pending + '.status==="loading"?"Refreshing context limits...":"Context limits unavailable; cancel"}];'
    + 'return ' + renderer.createElement + '(' + renderer.component + ',{options:displayOptions,onChange:function(choice){'
    + 'if(' + names.pending + '===null||' + names.pending + '.status!=="ready")return;'
    + 'const value=typeof choice==="string"?choice:choice&&choice.value;'
    + 'const selected=' + names.pending + '.options.find(function(option){return option.mode===value});'
    + 'if(selected)' + names.commit + '(' + names.pending + '.model,' + names.pending + '.effort,selected);'
    + '},onCancel:function(){' + names.cancel + '();}});}' ;
  const contextOptionHelper = CONTEXT_ROW_BASE_HELPER
    + contextAliasDeclaration
    + 'const __lfcContextIdentity=function(value){const base=__lfcBaseModel(value);return typeof base==="string"?(__lfcContextAliases[base.toLowerCase()]??base.toLowerCase()):base;};'
    + contextModelDeclaration
    + 'const __lfcNormalizeContextOptions=function(value){'
    + 'if(!Array.isArray(value))return value;'
    + 'const result=[];const indexes=Object.create(null);'
    + 'for(const option of value){'
    + 'if(!option||typeof option!=="object"||typeof option.value!=="string"){result.push(option);continue;}'
    + 'const base=__lfcContextIdentity(option.value);'
    + 'if(typeof base!=="string"||!Object.prototype.hasOwnProperty.call(__lfcContextModels,base)){result.push(option);continue;}'
    + 'const previous=indexes[base];'
    + 'if(previous===undefined){indexes[base]=result.length;result.push(option);continue;}'
    + 'const previousOption=result[previous];'
    + 'if(previousOption&&typeof previousOption.value==="string"&&__lfcBaseModel(previousOption.value)!==previousOption.value&&__lfcBaseModel(option.value)===option.value)result[previous]=option;'
    + '}'
    + 'return result;'
    + '};';
  const sharedState = 'var ' + names.generation + '=0;' + contextOptionHelper;
  const withHelper = source.slice(0, picker.functionStart)
    + sharedState
    + source.slice(picker.functionStart, picker.bodyStart)
    + helper
    + source.slice(picker.bodyStart);
  const normalizedOptions = patchOptional(withHelper, NORMALIZE_OPTIONS_PATTERN, replaceNormalizedOptions);
  if (normalizedOptions.fatal) return normalizedOptions;
  const selectedValue = patchOptional(normalizedOptions.content, SELECTED_VALUE_PATTERN, replaceSelectedValue);
  if (selectedValue.fatal) return selectedValue;
  const contextRows = patchOptional(selectedValue.content, CONTEXT_ROWS_PATTERN, replaceContextRows);
  if (contextRows.fatal) return contextRows;
  const selectedModel = patchOptional(contextRows.content, SELECTED_MODEL_PATTERN, replaceSelectedModel);
  if (selectedModel.fatal) return selectedModel;
  const patched = patchOnce(
    selectedModel.content,
    callbackPattern,
    (_match, model, effort) =>
      'if(' + names.begin + '(' + model! + ',' + effort! + '))return;'
      + picker.select + '(' + model! + ',' + effort! + ');}' + renderBranch,
  );
  return patched;
}
