import pc from 'picocolors';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runServerCommand } from './server/index.js';
import { resolveBridgeMode } from './config.js';
import { VERSION } from './constants.js';
import { runProvidersCommand, providersHelpText } from './providers-command.js';
import { refreshModelsDevCacheAsync } from './registry/models-dev.js';
import { keyringHelpText, runKeyringRepairCommand } from './keyring-command.js';
import { runPatchCommand } from './patcher.js';
import { installOutboundProxyDispatcher } from './outbound-proxy.js';
import { runExecutionsCommand } from './executions-command.js';
import { parseArgs } from './cli-args.js';
import { rootHelpText, claudeHelpText, serverHelpText, modelsHelpText, patchHelpText, printHelp } from './cli-help.js';
import { runModelsCommand } from './cli-command-models.js';
import { runClaudeCommand } from './cli-command-claude.js';

export { parseArgs } from './cli-args.js';
export { rootHelpText, claudeHelpText, serverHelpText, modelsHelpText, patchHelpText } from './cli-help.js';

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  await installOutboundProxyDispatcher();

  if (args[0] === 'executions') {
    return runExecutionsCommand(args.slice(1));
  }

  const parsed = parseArgs(args);

  if (parsed.error) {
    console.error(pc.red(`\nError: ${parsed.error}\n`));
    printHelp(rootHelpText());
    return 1;
  }

  if (!parsed.showVersion) {
    refreshModelsDevCacheAsync();
  }

  if (parsed.command === 'root') {
    if (parsed.showVersion) {
      console.log(VERSION);
    } else {
      printHelp(rootHelpText());
    }
    return 0;
  }

  if (parsed.command === 'server') {
    if (parsed.showVersion) {
      console.log(VERSION);
      return 0;
    }
    if (parsed.showHelp) {
      printHelp(serverHelpText());
      return 0;
    }
    const bridgeMode = resolveBridgeMode('server', parsed.bridgeMode, {
      persist: Boolean(parsed.saveBridgeMode),
    });
    return runServerCommand({
      httpProxy: bridgeMode === 'proxy',
      quick: parsed.serverQuick,
      listenMode: parsed.serverListenMode,
      providersMode: parsed.serverProvidersMode,
      providerIds: parsed.serverProviderIds,
      maskGatewayIds: parsed.serverMaskGatewayIds,
      password: parsed.serverPassword ?? process.env['LEVERFRAME_SERVER_PASSWORD'],
      wsDiagnostics: parsed.serverWsDiagnostics,
      port: parsed.serverPort,
      noDiscovery: parsed.serverNoDiscovery,
    });
  }

  if (parsed.command === 'models') {
    if (parsed.showVersion) {
      console.log(VERSION);
      return 0;
    }
    if (parsed.showHelp) {
      printHelp(modelsHelpText());
      return 0;
    }
    return runModelsCommand({
      list: parsed.favoritesList,
      alias: parsed.favoritesAlias,
      unalias: parsed.favoritesUnalias,
      contextCeiling: parsed.favoritesContextCeiling,
      noContextCeiling: parsed.favoritesNoContextCeiling,
    });
  }

  if (parsed.command === 'providers') {
    if (parsed.showVersion) {
      console.log(VERSION);
      return 0;
    }
    if (parsed.showHelp) {
      printHelp(providersHelpText());
      return 0;
    }
    if (parsed.trace) {
      process.env.LEVERFRAME_TRACE = '1';
    }
    return runProvidersCommand(parsed.claudeArgs);
  }

  if (parsed.command === 'executions') {
    if (parsed.showVersion) {
      console.log(VERSION);
      return 0;
    }
    return runExecutionsCommand(parsed.claudeArgs);
  }

  if (parsed.command === 'keyring') {
    if (parsed.showVersion) {
      console.log(VERSION);
      return 0;
    }
    if (parsed.showHelp) {
      printHelp(keyringHelpText());
      return 0;
    }
    return runKeyringRepairCommand(parsed.keyringRepairAccount);
  }

  if (parsed.command === 'patch') {
    if (parsed.showVersion) {
      console.log(VERSION);
      return 0;
    }
    if (parsed.showHelp) {
      printHelp(patchHelpText());
      return 0;
    }
    return runPatchCommand({
      restore: parsed.patchRestore,
      trace: parsed.trace,
      target: parsed.patchTarget,
      diagnose: parsed.patchDiagnose,
      json: parsed.patchJson,
    });
  }

  if (parsed.showVersion) {
    console.log(VERSION);
    return 0;
  }
  if (parsed.showHelp) {
    printHelp(claudeHelpText());
    return 0;
  }

  return runClaudeCommand(parsed);
}

function isCliEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isCliEntryPoint()) {
  main().then((exitCode) => {
    process.exit(exitCode);
  }).catch((err: unknown) => {
    if (err === Symbol.for('clack:cancel')) {
      process.exit(0);
    }
    console.error(pc.red('\nUnexpected error:'), err);
    process.exit(1);
  });
}
