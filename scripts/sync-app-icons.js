#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [commandsPath, iconsDir] = process.argv.slice(2);
if (!commandsPath || !iconsDir) {
  console.error('Usage: sync-app-icons.js <commands.json> <iconsDir>');
  process.exit(1);
}

function run(bin, args) {
  return spawnSync(bin, args, { encoding: 'utf8' });
}

function runText(bin, args) {
  const ret = run(bin, args);
  if (ret.error || ret.status !== 0) return '';
  return (ret.stdout || '').trim();
}

function plistRead(plistPath, keyPath) {
  const out = runText('/usr/libexec/PlistBuddy', ['-c', `Print ${keyPath}`, plistPath]);
  return out || '';
}

function normalizeCommands(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.commands)) return raw.commands;
  return [];
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appBundleCandidates(appName) {
  return [
    `/Applications/${appName}.app`,
    `/Applications/Utilities/${appName}.app`,
    `/System/Applications/${appName}.app`,
    `/System/Applications/Utilities/${appName}.app`,
    `/System/Library/CoreServices/${appName}.app`
  ];
}

function resolveAppBundlePath(appName) {
  for (const p of appBundleCandidates(appName)) {
    if (fs.existsSync(p)) return p;
  }

  const query = `kMDItemContentType == "com.apple.application-bundle" && (kMDItemDisplayName == "${appName}" || kMDItemFSName == "${appName}.app")`;
  const out = runText('mdfind', [query]);
  if (!out) return '';

  for (const line of out.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (line.endsWith('.app') && fs.existsSync(line)) {
      return line;
    }
  }
  return '';
}

function resolveIconSource(appBundlePath) {
  const plistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
  if (!fs.existsSync(plistPath)) return '';

  const candidates = [];
  const v1 = plistRead(plistPath, ':CFBundleIconFile');
  const v2 = plistRead(plistPath, ':CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconFile');
  const v3 = plistRead(plistPath, ':CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconFiles:0');

  [v1, v2, v3].forEach((v) => {
    if (v) {
      candidates.push(v);
      if (!path.extname(v)) candidates.push(`${v}.icns`);
      if (!path.extname(v)) candidates.push(`${v}.png`);
    }
  });

  const resourcesDir = path.join(appBundlePath, 'Contents', 'Resources');
  for (const name of candidates) {
    const p = path.join(resourcesDir, name);
    if (fs.existsSync(p)) return p;
  }

  const fallbackIcns = fs.readdirSync(resourcesDir)
    .filter((f) => f.toLowerCase().endsWith('.icns'))
    .sort();

  if (fallbackIcns.length > 0) {
    return path.join(resourcesDir, fallbackIcns[0]);
  }
  return '';
}

function convertToPng(src, outPath) {
  const ret = run('sips', ['-s', 'format', 'png', src, '--out', outPath]);
  return !ret.error && ret.status === 0 && fs.existsSync(outPath);
}

function main() {
  ensureDir(iconsDir);

  const rawText = fs.readFileSync(commandsPath, 'utf8');
  const parsed = JSON.parse(rawText);
  const commands = normalizeCommands(parsed);

  const openAppCommands = commands.filter((cmd) =>
    cmd && cmd.id && cmd.action && cmd.action.type === 'open_app' && typeof cmd.action.app === 'string'
  );

  const keepIds = new Set(openAppCommands.map((c) => c.id));
  for (const file of fs.readdirSync(iconsDir)) {
    if (!file.endsWith('.png')) continue;
    const id = file.replace(/\.png$/, '');
    if (!keepIds.has(id)) {
      fs.unlinkSync(path.join(iconsDir, file));
    }
  }

  let generated = 0;
  let skipped = 0;

  for (const cmd of openAppCommands) {
    const appName = cmd.action.app;
    const appBundle = resolveAppBundlePath(appName);
    if (!appBundle) {
      skipped += 1;
      continue;
    }

    const iconSrc = resolveIconSource(appBundle);
    if (!iconSrc) {
      skipped += 1;
      continue;
    }

    const outPath = path.join(iconsDir, `${cmd.id}.png`);
    const ok = convertToPng(iconSrc, outPath);
    if (ok) generated += 1;
    else skipped += 1;
  }

  process.stdout.write(`icons generated=${generated}, skipped=${skipped}`);
}

try {
  main();
} catch (err) {
  console.error(err.message || String(err));
  process.exit(1);
}
