import type { RoutingNoticePatchOutcome } from './patch-transforms-routing-notice.js';
import { escapePattern, resolveRoutingBinding } from './patch-routing-bindings.js';
import { findBalancedBlockEnd } from './patch-transforms-picker.js';

const IDENT = '[A-Za-z_$][\\w$]*';
const START = '/*ccpatch:routing-v3:start*/';
const END = '/*ccpatch:routing-v3:end*/';
const CALL = /async call\(([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\{let\{subagent_type:/;
const CONFIG = new RegExp('let (' + IDENT + ')=\\{agentDefinition:(' + IDENT + '),');
const MODEL = new RegExp('(' + IDENT + ')=' + IDENT + '\\(' + IDENT + '\\((' + IDENT + '),(' + IDENT + ')\\),\\3,(' + IDENT + '),(' + IDENT + ')\\)');
const CALLBACK = new RegExp('onModelRestricted:\\((' + IDENT + '),(' + IDENT + ')\\)=>(' + IDENT + ')\\?\\.\\(\\{type:"notification",notification:\\{key:`agent-model-restricted-[^`]+`,text:`[^`]+`,priority:"medium",color:"warning",timeoutMs:1e4\\}\\}\\)');
const LAUNCH = new RegExp('let (' + IDENT + ')=await ' + IDENT + '\\(\\),(' + IDENT + ')=' + IDENT + '\\(\\);' + IDENT + '\\.spawnedSubagent=\\2;');
const STATE_EFFORT = /function ([\w$]+)\(([\w$]+),[\w$]+\)\{let ([\w$]+)=\2\.sessionEffort\?\?[\w$]+;switch\(\3\.kind\)\{case"level":return \3\.value;case"default":return;case"inherit":/;
const EFFECTIVE_EFFORT = /function ([\w$]+)\(([\w$]+),([\w$]+),\{honorLaunchPin:[\w$]+=!0\}=\{\}\)\{if\(![\w$]+\(\2\)\)return;/;
const MODEL_DISPLAY = /function ([\w$]+)\(([\w$]+)\)\{return [\w$]+\([\w$]+\(\2,\{identity:!0\}\),\2\.endsWith\("\[1m\]"\)\)\}/;

function unique(source: string, pattern: RegExp): RegExpMatchArray | undefined {
  const matches = [...source.matchAll(new RegExp(pattern.source, 'g'))];
  return matches.length === 1 ? matches[0] : undefined;
}

function result(content: string, status: 'OK' | 'SKIP' | 'FAIL', extra?: string): RoutingNoticePatchOutcome {
  return {
    content,
    results: ['PATCH 10: routing notice', 'PATCH 10d: agent description indicator']
      .map(name => ({ status, name, ...(extra === undefined ? {} : { extra }) })),
  };
}

function property(params: string, name: string): string | undefined {
  return unique(params, new RegExp('(?:^|,)' + name + ':(' + IDENT + ')(?:,|$)'))?.[1];
}

function bodyContains(source: string, start: number, match: RegExpMatchArray): boolean {
  const end = findBalancedBlockEnd(source, start);
  return end !== undefined && match.index! >= start && match.index! + match[0].length <= end
    && !source.slice(start, end).includes(['\n', '//#__leverframe_claude_module__:'].join(''));
}

interface RoutingSite {
  agent: string;
  description: string;
  context: string;
  config: string;
  model: string;
  notify: string;
  insertAt: number;
  readEffort: string;
  effectiveEffort: string;
  displayModel: string;
}

function routingSnippet(site: RoutingSite, displays: Record<string, string>): string {
  const table = JSON.stringify(JSON.stringify(displays).replaceAll('/', '\\u002f'));
  return (START + '(()=>{'
    + `if(${site.config}.override?.replHydration?.kind!=="resume"){`
    + 'let __lfcModel=' + site.model + ','
    + '__lfcKey=String(__lfcModel).trim().toLowerCase(),__lfcDisplays=Object.assign(Object.create(null),JSON.parse(' + table + ')),'
    + '__lfcEffort=String(' + site.effectiveEffort + '(__lfcModel,' + site.agent + '.effort??'
    + site.readEffort + '(' + site.context + '.getAppState(),__lfcModel),'
    + '{honorLaunchPin:' + site.config + '.querySource!=="auto_mode_investigator"})??"default"),'
    + '__lfcDisplay=__lfcDisplays[__lfcKey]??__lfcDisplays[__lfcKey.replace(/(?:\\[(?:default|maximum|1m)\\])+$/i,"")]??'
    + site.displayModel + '(__lfcModel)??__lfcModel,'
    + '__lfcAgent=String(' + site.agent + '.agentType);'
    + '__lfcDisplay=String(__lfcDisplay).trim().replace(/\\s+/g," ");'
    + site.description + '=String(' + site.description + '??"")+" \\u00b7 "+__lfcDisplay+" \\u00b7 "+__lfcEffort;'
    + site.config + '.description=' + site.description + ';'
    + 'const __lfcSegments=[{text:"Agent "},{text:__lfcAgent,color:"suggestion",bold:!0},{text:" · Model "},'
    + '{text:__lfcDisplay,color:"suggestion",bold:!0},{text:" · Effort "},{text:__lfcEffort,color:"success",bold:!0}];'
    + site.notify + '?.({type:"notification",notification:{key:"leverframe-routing-success-"+Date.now()+"-"+Math.random(),'
    + 'text:__lfcSegments.map(segment=>segment.text).join(""),segments:__lfcSegments,priority:"high",timeoutMs:1e4}});}})();' + END)
    .replace(/[\u0080-\uffff]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}

function resolveSite(source: string, call: RegExpMatchArray, config: RegExpMatchArray, model: RegExpMatchArray, callback: RegExpMatchArray): RoutingSite | undefined {
  const bodyStart = call.index! + call[0].indexOf('{') + 1;
  if (callback[3] !== call[5] || config[2] !== model[2] || model.index! >= config.index!
    || ![config, model, callback].every(match => bodyContains(source, bodyStart, match))) return undefined;
  const objectStart = config.index! + config[0].indexOf('{') + 1;
  const objectEnd = findBalancedBlockEnd(source, objectStart);
  if (objectEnd === undefined || callback.index! < objectStart || callback.index! + callback[0].length > objectEnd) return undefined;
  const bodyEnd = findBalancedBlockEnd(source, bodyStart);
  const launch = unique(source.slice(objectEnd + 1, bodyEnd), LAUNCH);
  if (!launch) return undefined;
  const description = property(source.slice(objectStart, objectEnd), 'description');
  const offset = call.index!;
  const readEffort = resolveRoutingBinding(source, STATE_EFFORT, offset);
  const effectiveEffort = resolveRoutingBinding(source, EFFECTIVE_EFFORT, offset);
  const displayModel = resolveRoutingBinding(source, MODEL_DISPLAY, offset);
  if (!description || !readEffort || !effectiveEffort || !displayModel) return undefined;
  return { agent: config[2]!, description, context: call[2]!, config: config[1]!, model: model[1]!,
    notify: call[5]!, insertAt: objectEnd + 1 + launch.index! + launch[0].length, readEffort, effectiveEffort, displayModel };
}

export function applyModernRoutingNotice(source: string, displays: Record<string, string>): RoutingNoticePatchOutcome | undefined {
  const markerCounts = [START, END].map(marker => source.split(marker).length - 1);
  if (source.includes('/*ccpatch:routing-v2:')) return result(source, 'FAIL', 'Rebuild routing integration from the verified baseline');
  if (!CALL.test(source) && markerCounts.every(count => count === 0)) return undefined;
  const call = unique(source, CALL);
  const config = unique(source, CONFIG);
  const callback = unique(source, CALLBACK);
  if (!call || !config || !callback) return result(source, 'FAIL', 'Agent routing anchors are missing or ambiguous');
  const model = unique(source.slice(call.index, config.index), MODEL);
  if (!model) return result(source, 'FAIL', 'Agent resolved model is missing or ambiguous');
  model.index = call.index! + model.index!;
  const site = resolveSite(source, call, config, model, callback);
  if (!site) return result(source, 'FAIL', 'Agent routing scope, effort, or display bindings are unavailable');
  const snippet = routingSnippet(site, displays);
  if (markerCounts.some(count => count !== 0)) {
    const block = new RegExp(escapePattern(START) + '[\\s\\S]*?' + escapePattern(END));
    const existing = unique(source, block);
    if (markerCounts.some(count => count !== 1) || existing?.index !== site.insertAt) {
      return result(source, 'FAIL', 'Agent routing patch is incomplete');
    }
    const content = source.replace(block, () => snippet);
    return result(content, content === source ? 'SKIP' : 'OK', content === source ? 'already integrated' : undefined);
  }
  const content = source.slice(0, site.insertAt) + snippet + source.slice(site.insertAt);
  return result(content, 'OK');
}
