import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

const originalClamp = 'Me({timeout_ms:e.timeout_ms??12e4,max:12e4})';

export function patchDownloadTimeout(source, minutes = 60) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error('Minutes must be an integer from 1 to 60.');
  const handlers = ['playwright_wait_for_download', 'playwright_locator_download_media'];
  const edits = handlers.map(name => {
    const start = source.indexOf(`M("${name}",`);
    if (start < 0) throw new Error(`Unsupported runtime: missing ${name}`);
    const end = source.indexOf('});c();', start);
    const at = source.indexOf(originalClamp, start);
    if (end < 0 || at < 0 || at >= end) throw new Error(`Unsupported runtime: missing expected download clamp in ${name}`);
    return at;
  });
  if (source.split(originalClamp).length - 1 !== 2) throw new Error('Unsupported runtime: unexpected timeout layout.');
  const ms = minutes * 60_000;
  const replacement = `Me({timeout_ms:e.timeout_ms??${ms},max:${ms}})`;
  let result = source;
  for (const at of edits.sort((a, b) => b - a)) result = result.slice(0, at) + replacement + result.slice(at + originalClamp.length);
  return result;
}

export function configureDownloadTimeout(pluginDefinitionPath, minutes = 60, codexHome = path.join(os.homedir(), '.codex')) {
  const definition = JSON.parse(fs.readFileSync(pluginDefinitionPath, 'utf8'));
  const server = definition.mcpServers?.cua_repl;
  if (!server?.env?.NODE_REPL_NODE_MODULE_DIRS) throw new Error('The plugin does not expose its runtime module directory.');
  const moduleDirs = server.env.NODE_REPL_NODE_MODULE_DIRS.split(path.delimiter);
  const sourceRoot = moduleDirs.map(dir => path.join(dir, '@oai', 'browser-desktop')).find(dir => fs.existsSync(path.join(dir, 'scripts', 'browser-service.mjs')));
  if (!sourceRoot) throw new Error('Could not locate the installed browser runtime.');
  const sourceFile = path.join(sourceRoot, 'scripts', 'browser-service.mjs');
  const original = fs.readFileSync(sourceFile, 'utf8');
  const patched = patchDownloadTimeout(original, minutes);
  const hash = crypto.createHash('sha256').update(original).digest('hex');
  const localRoot = path.join(codexHome, 'runtime-overrides', 'browser-download-timeout', `${hash.slice(0, 12)}-${minutes}min`);
  fs.mkdirSync(localRoot, { recursive: true });
  fs.cpSync(sourceRoot, localRoot, { recursive: true });
  fs.writeFileSync(path.join(localRoot, 'scripts', 'browser-service.mjs'), patched);
  const dependencies = path.join(localRoot, 'node_modules');
  if (!fs.existsSync(dependencies)) fs.symlinkSync(path.resolve(sourceRoot, '..', '..'), dependencies, process.platform === 'win32' ? 'junction' : 'dir');
  const services = JSON.parse(server.env.NODE_REPL_TRUSTED_SERVICES ?? '{}');
  services.browser = pathToFileURL(path.join(localRoot, 'scripts', 'browser-service.mjs')).href;
  server.env.NODE_REPL_TRUSTED_SERVICES = JSON.stringify(services);
  server.tool_timeout_sec = Math.max(server.tool_timeout_sec ?? 0, minutes * 60 + 120);
  const backup = `${pluginDefinitionPath}.before-download-timeout`;
  if (!fs.existsSync(backup)) fs.copyFileSync(pluginDefinitionPath, backup);
  fs.writeFileSync(path.join(localRoot, 'patch-info.json'), JSON.stringify({ minutes, sourceFile, sourceSha256: hash, pluginDefinitionPath, backup }, null, 2) + '\n');
  fs.writeFileSync(pluginDefinitionPath, JSON.stringify(definition, null, 2) + '\n');
  return { minutes, localRoot, pluginDefinitionPath, backup, activation: 'Restart the MCP server or start a new conversation to load the override.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [definition, requested = '60'] = process.argv.slice(2);
  if (!definition) throw new Error('Usage: node scripts/browser-download-timeout.mjs <plugin .mcp.json> [minutes, 1-60]');
  console.log(JSON.stringify(configureDownloadTimeout(path.resolve(definition), Number(requested)), null, 2));
}
