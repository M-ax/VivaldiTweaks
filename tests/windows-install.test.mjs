import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const installerScript = join(projectRoot, 'scripts', 'install.ps1');
const fixtureParent = join(projectRoot, '.test-fixtures');
const startMarker = '<!-- vivaldi-constellation:start -->';
const endMarker = '<!-- vivaldi-constellation:end -->';
const owner = 'VivaldiTweaks:signal-constellation\n';
const ownedFolder = 'vivaldi-constellation';
const assets = new Map([
  ['constellation.css', 'constellation/constellation.css'],
  ['constellation-engine.js', 'constellation/constellation-engine.js'],
  ['constellation.js', 'constellation/constellation.js'],
  ['address-bar-below-tabs.css', 'mods/address-bar-below-tabs.css'],
]);
const spawnOptions = {
  cwd: projectRoot,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 30_000,
  maxBuffer: 4 * 1024 * 1024,
};

function createFixture(t, { newline = '\n', bom = false, version = '8.2.4133.96' } = {}) {
  // Never use the OS temp directory: all generated files belong to this worktree.
  mkdirSync(fixtureParent, { recursive: true });
  const root = mkdtempSync(join(fixtureParent, 'windows-install-'));
  const installation = join(root, "Vivaldi fixture's [spaces] & mods");
  const application = join(installation, 'Application');
  const ui = join(application, version, 'resources', 'vivaldi');
  mkdirSync(ui, { recursive: true });
  const original = Buffer.from(`${bom ? '\uFEFF' : ''}${[
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '  <meta charset="utf-8">',
    '  <title>Vivaldi — café 星</title>',
    '  <link rel="stylesheet" href="other-mod.css">',
    '</head>',
    '<body>',
    '  <!-- another mod: leave this alone -->',
    '  <div id="browser"></div>',
    '  <script src="other-mod.js"></script>',
    '</body>',
    '</html>',
    '',
  ].join(newline)}`, 'utf8');
  const window = join(ui, 'window.html');
  writeFileSync(window, original);
  writeFileSync(join(ui, 'other-mod.js'), '// another mod\n');
  writeFileSync(join(ui, 'other-mod.css'), '/* another mod */\n');
  const processes = [];
  t.after(async () => {
    // Windows cannot remove a running executable; stop only our own fixtures.
    try {
      for (const child of processes) {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill();
          await exited;
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  return {
    root, installation, application, ui, window, original, newline, bom, processes,
    owned: join(ui, ownedFolder),
    backup: `${window}.tweaks-backup`,
  };
}

function runInstaller(fixture, {
  action = 'Install',
  positional = false,
  whatIf = false,
  script = installerScript,
  target = fixture.window,
} = {}) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
  if (action !== null) args.push('-Action', action);
  args.push(...(positional ? [target] : ['-VivaldiPath', target]));
  if (whatIf) args.push('-WhatIf');
  return spawnSync('powershell.exe', args, spawnOptions);
}

function runLauncher(fixture, launcher, { whatIf = false, positional = false } = {}) {
  const args = [
    join(projectRoot, launcher),
    ...(positional ? [fixture.window] : ['-VivaldiPath', fixture.window]),
    ...(whatIf ? ['-WhatIf'] : []),
  ];
  // /s strips the outer pair; preserve the inner quotes for paths and shell
  // metacharacters. Do not let Node apply its different C-runtime quoting here.
  const command = `"${args.map((arg) => `"${arg}"`).join(' ')}"`;
  return spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
    ...spawnOptions,
    windowsVerbatimArguments: true,
    input: '\r\n',
  });
}

function outputOf(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function assertExit(result, success = true) {
  const output = outputOf(result);
  assert.equal(result.error, undefined, `Could not run installer: ${result.error}\n${output}`);
  assert.equal(result.signal, null, `Installer was interrupted:\n${output}`);
  assert.equal(typeof result.status, 'number', `Installer returned no exit code:\n${output}`);
  if (success) assert.equal(result.status, 0, output);
  else assert.notEqual(result.status, 0, `Expected a failing exit code:\n${output}`);
}

function assertPauseCount(result, expected) {
  const count = (outputOf(result).match(/\bpress\s+enter\b/gi) ?? []).length;
  assert.equal(count, expected, `Expected ${expected} final pause prompt(s):\n${outputOf(result)}`);
}

function snapshotTree(root, { includeTimes = true } = {}) {
  const entries = [];
  const visit = (path, name) => {
    const stat = lstatSync(path);
    const entry = { path: name };
    if (includeTimes) entry.mtimeMs = stat.mtimeMs;
    if (stat.isSymbolicLink()) {
      entry.type = 'link';
      entry.target = readlinkSync(path);
    } else if (stat.isDirectory()) {
      entry.type = 'directory';
    } else {
      assert.ok(stat.isFile(), `Unexpected fixture file type: ${path}`);
      entry.type = 'file';
      entry.size = stat.size;
      entry.sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
    entries.push(entry);
    if (entry.type === 'directory') {
      for (const child of readdirSync(path).sort()) {
        visit(join(path, child), `${name}/${child}`);
      }
    }
  };
  visit(root, '.');
  return entries;
}

function assertFailureWithoutMutation(fixture, options = {}) {
  const before = snapshotTree(fixture.root);
  const result = runInstaller(fixture, options);
  assertExit(result, false);
  assert.deepEqual(snapshotTree(fixture.root), before, outputOf(result));
  return result;
}

function removeOwnedBlock(html) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker);
  assert.ok(start >= 0 && end > start, 'one complete owned block');
  return html.slice(0, start) + html.slice(end + endMarker.length).replace(/^\r?\n/, '');
}

function assertInstalled(fixture) {
  const html = readFileSync(fixture.window, 'utf8');
  assert.equal(html.split(startMarker).length - 1, 1, 'one start marker');
  assert.equal(html.split(endMarker).length - 1, 1, 'one end marker');
  const block = html.slice(html.indexOf(startMarker), html.indexOf(endMarker));
  const links = [...block.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1].replace(/^\.\//, ''));
  const scripts = [...block.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1].replace(/^\.\//, ''));
  assert.deepEqual(links.sort(), [
    `${ownedFolder}/address-bar-below-tabs.css`,
    `${ownedFolder}/constellation.css`,
  ]);
  assert.deepEqual(scripts, [
    `${ownedFolder}/constellation-engine.js`,
    `${ownedFolder}/constellation.js`,
  ], 'engine must load before adapter');
  assert.equal(readFileSync(join(fixture.owned, '.owner'), 'utf8'), owner);
  for (const [name, source] of assets) {
    assert.deepEqual(
      readFileSync(join(fixture.owned, name)),
      readFileSync(join(projectRoot, source)),
      `${name} must be copied unchanged`,
    );
  }
  return html;
}

function seedOwnedFolder(fixture, names = [...assets.keys()]) {
  mkdirSync(fixture.owned, { recursive: true });
  writeFileSync(join(fixture.owned, '.owner'), owner);
  for (const name of names) writeFileSync(join(fixture.owned, name), `legacy ${name}\n`);
}

function stageInstaller(fixture, omittedAssets = []) {
  // Isolate missing-source scenarios without moving or editing project assets.
  const root = join(fixture.root, 'installer kit with spaces');
  const script = join(root, 'scripts', 'install.ps1');
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(installerScript, script);
  for (const [name, source] of assets) {
    if (omittedAssets.includes(name)) continue;
    const destination = join(root, source);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(projectRoot, source), destination);
  }
  return script;
}

async function startFixtureVivaldi(fixture) {
  // A renamed Node binary gives Get-Process a real vivaldi.exe image and path,
  // without launching the user's browser or depending on Vivaldi being installed.
  const executable = join(fixture.application, 'vivaldi.exe');
  copyFileSync(process.execPath, executable);
  const child = spawn(executable, [
    '-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
  ], {
    cwd: fixture.application,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  fixture.processes.push(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.stdout.removeListener('data', onData);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    const onExit = (code) => finish(new Error(`Fixture vivaldi.exe exited (${code}): ${stderr}`));
    const onData = (chunk) => {
      if (chunk.toString().includes('ready')) finish();
    };
    const timer = setTimeout(() => finish(new Error(`Fixture vivaldi.exe did not start: ${stderr}`)), 10_000);
    child.once('error', onError);
    child.once('exit', onExit);
    child.stdout.on('data', onData);
  });
  return child;
}

describe('combined Windows installer', {
  skip: process.platform !== 'win32' ? 'requires Windows PowerShell 5.1 and cmd.exe' : false,
  concurrency: false,
}, () => {
  for (const format of [
    { name: 'LF UTF-8', newline: '\n', bom: false },
    { name: 'CRLF UTF-8', newline: '\r\n', bom: false },
    { name: 'CRLF UTF-8 with BOM', newline: '\r\n', bom: true },
  ]) {
    test(`installs, reruns, and uninstalls without disturbing ${format.name} or other mods`, (t) => {
      const fixture = createFixture(t, format);
      const result = runInstaller(fixture, { action: null, positional: true });
      assertExit(result);
      assertPauseCount(result, 0);
      const installed = assertInstalled(fixture);
      assert.equal(removeOwnedBlock(installed), fixture.original.toString('utf8'));
      assert.equal(installed.startsWith('\uFEFF'), fixture.bom, 'preserve UTF-8 BOM choice');
      if (fixture.newline === '\r\n') {
        assert.ok(!installed.replaceAll('\r\n', '').includes('\n'), 'no added bare LF');
      } else {
        assert.ok(!installed.includes('\r'), 'no added CRLF');
      }
      assert.deepEqual(readFileSync(fixture.backup), fixture.original, 'backup exact original bytes');
      assert.deepEqual(readdirSync(fixture.owned).sort(), ['.owner', ...assets.keys()].sort());
      const firstInstall = snapshotTree(fixture.root, { includeTimes: false });
      assertExit(runInstaller(fixture));
      assert.deepEqual(snapshotTree(fixture.root, { includeTimes: false }), firstInstall, 'idempotent rerun');

      // A later edit must survive removal; restoring the full backup would lose it.
      const laterMod = '  <script src="added-after-install.js"></script>';
      writeFileSync(fixture.window, installed.replace('</body>', `${laterMod}${fixture.newline}</body>`));
      const expected = fixture.original.toString('utf8')
        .replace('</body>', `${laterMod}${fixture.newline}</body>`);
      assertExit(runInstaller(fixture, { action: 'Uninstall' }));
      assert.deepEqual(readFileSync(fixture.window), Buffer.from(expected));
      assert.ok(!existsSync(fixture.owned), 'remove empty owned folder');
      assert.deepEqual(readFileSync(fixture.backup), fixture.original, 'keep original backup');
      assert.equal(readFileSync(join(fixture.ui, 'other-mod.js'), 'utf8'), '// another mod\n');
      assert.equal(readFileSync(join(fixture.ui, 'other-mod.css'), 'utf8'), '/* another mod */\n');
      const firstUninstall = snapshotTree(fixture.root, { includeTimes: false });
      assertExit(runInstaller(fixture, { action: 'Uninstall' }));
      assert.deepEqual(snapshotTree(fixture.root, { includeTimes: false }), firstUninstall);
    });
  }

  test('resolves installation, Application, and executable paths using metadata, not the newest directory', (t) => {
    assert.ok(process.env.SystemRoot, 'Windows SystemRoot must be available');
    const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // The system path may resolve sidecar MUI metadata. Inspect a standalone
    // renamed copy, matching the executable the installer will actually inspect.
    const metadataFixture = createFixture(t);
    const metadataExecutable = join(metadataFixture.application, 'vivaldi.exe');
    copyFileSync(powershell, metadataExecutable);
    const metadata = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      '[Console]::Write((Get-Item -LiteralPath $env:VIVALDI_TEST_VERSION_SOURCE).VersionInfo.ProductVersion)',
    ], {
      ...spawnOptions,
      env: { ...process.env, VIVALDI_TEST_VERSION_SOURCE: metadataExecutable },
    });
    assertExit(metadata);
    const version = /^(\d+\.\d+\.\d+\.\d+)(?:\D|$)/.exec(metadata.stdout.trim())?.[1];
    if (!version) {
      t.skip('The copied executable does not expose a four-part ProductVersion for this optional discovery fixture');
      return;
    }
    const fixture = createFixture(t, { version });
    const executable = join(fixture.application, 'vivaldi.exe');
    // Never execute this renamed PowerShell binary; it supplies metadata only.
    copyFileSync(metadataExecutable, executable);
    const newerVersion = `${Number(version.split('.')[0]) + 1}.0.0.0`;
    const newerUi = join(fixture.application, newerVersion, 'resources', 'vivaldi');
    mkdirSync(newerUi, { recursive: true });
    writeFileSync(join(newerUi, 'window.html'), fixture.original);
    const before = snapshotTree(fixture.root);
    for (const target of [fixture.installation, fixture.application, executable]) {
      const preview = runInstaller(fixture, { target, positional: true, whatIf: true });
      assertExit(preview);
      assert.ok(outputOf(preview).toLowerCase().includes(fixture.window.toLowerCase()),
        'preview should identify the executable-matching version');
      assert.deepEqual(snapshotTree(fixture.root), before);
    }
    assertExit(runInstaller(fixture, { target: fixture.installation }));
    assertInstalled(fixture);
    assertExit(runInstaller(fixture, { target: fixture.application }));
    assertInstalled(fixture);
    assertExit(runInstaller(fixture, { action: 'Uninstall', target: executable }));
    assert.deepEqual(readFileSync(fixture.window), fixture.original);
    assert.deepEqual(readFileSync(join(newerUi, 'window.html')), fixture.original);
    assert.deepEqual(readdirSync(newerUi), ['window.html'], 'leave staged update completely untouched');
  });

  test('preserves an existing backup rather than overwriting or restoring it', (t) => {
    const fixture = createFixture(t);
    const existingBackup = Buffer.from('An older backup that must not replace current HTML.\r\n');
    writeFileSync(fixture.backup, existingBackup);
    assertExit(runInstaller(fixture));
    assertInstalled(fixture);
    assert.deepEqual(readFileSync(fixture.backup), existingBackup);
    assertExit(runInstaller(fixture, { action: 'Uninstall' }));
    assert.deepEqual(readFileSync(fixture.window), fixture.original);
    assert.deepEqual(readFileSync(fixture.backup), existingBackup);
  });

  test('WhatIf is read-only for fresh and already-installed targets', (t) => {
    const fixture = createFixture(t);
    for (const installed of [false, true]) {
      if (installed) assertExit(runInstaller(fixture));
      for (const action of ['Install', 'Uninstall']) {
        const before = snapshotTree(fixture.root);
        const result = runInstaller(fixture, { action, whatIf: true });
        assertExit(result);
        assertPauseCount(result, 0);
        assert.deepEqual(snapshotTree(fixture.root), before, `${action} -WhatIf`);
      }
    }
  });

  test('upgrades a legacy three-asset install in place with the original ownership identity', (t) => {
    const fixture = createFixture(t, { newline: '\r\n', bom: true });
    const legacyBlock = [
      startMarker,
      `<link rel="stylesheet" href="${ownedFolder}/constellation.css">`,
      `<script src="${ownedFolder}/constellation-engine.js"></script>`,
      `<script src="${ownedFolder}/constellation.js"></script>`,
      endMarker,
    ].join(fixture.newline);
    const legacyHtml = fixture.original.toString('utf8')
      .replace('</body>', `${legacyBlock}${fixture.newline}</body>`);
    writeFileSync(fixture.window, legacyHtml);
    seedOwnedFolder(fixture, ['constellation.css', 'constellation-engine.js', 'constellation.js']);
    assertExit(runInstaller(fixture));
    const upgraded = assertInstalled(fixture);
    assert.equal(removeOwnedBlock(upgraded), fixture.original.toString('utf8'));
    assert.equal(readFileSync(fixture.backup, 'utf8'), legacyHtml);
    assertExit(runInstaller(fixture, { action: 'Uninstall' }));
    assert.deepEqual(readFileSync(fixture.window), fixture.original);
  });

  test('preserves unknown owned-folder files and its owner across uninstall and reinstall', (t) => {
    const fixture = createFixture(t);
    assertExit(runInstaller(fixture));
    const userDirectory = join(fixture.owned, 'user files');
    mkdirSync(userDirectory);
    writeFileSync(join(userDirectory, 'custom.js'), '// keep my nested mod\n');
    writeFileSync(join(fixture.owned, 'notes.txt'), 'Keep my notes.\n');
    for (let cycle = 0; cycle < 2; cycle += 1) {
      if (cycle) {
        assertExit(runInstaller(fixture));
        assertInstalled(fixture);
      }
      assertExit(runInstaller(fixture, { action: 'Uninstall' }));
      assert.deepEqual(readFileSync(fixture.window), fixture.original);
      assert.deepEqual(readFileSync(fixture.backup), fixture.original);
      assert.equal(readFileSync(join(fixture.owned, '.owner'), 'utf8'), owner);
      assert.equal(readFileSync(join(fixture.owned, 'notes.txt'), 'utf8'), 'Keep my notes.\n');
      assert.equal(readFileSync(join(userDirectory, 'custom.js'), 'utf8'), '// keep my nested mod\n');
      assert.deepEqual(readdirSync(fixture.owned).sort(), ['.owner', 'notes.txt', 'user files']);
    }
  });

  test('uninstall removes the owned block and only one immediately following newline', (t) => {
    const fixture = createFixture(t, { newline: '\r\n', bom: true });
    const block = [
      startMarker,
      `<script src="${ownedFolder}/constellation.js"></script>`,
      endMarker,
    ].join(fixture.newline);
    const html = fixture.original.toString('utf8')
      .replace('</body>', `${block}${fixture.newline}${fixture.newline}</body>`);
    writeFileSync(fixture.window, html);
    seedOwnedFolder(fixture);
    assertExit(runInstaller(fixture, { action: 'Uninstall' }));
    const expected = fixture.original.toString('utf8').replace('</body>', `${fixture.newline}</body>`);
    assert.deepEqual(readFileSync(fixture.window), Buffer.from(expected));
    assert.ok(!existsSync(fixture.backup), 'uninstall does not create a backup');
  });

  for (const [name, markers] of [
    ['orphan start', startMarker],
    ['orphan end', endMarker],
    ['reversed markers', `${endMarker}\n${startMarker}`],
    ['duplicate blocks', `${startMarker}\n${endMarker}\n${startMarker}\n${endMarker}`],
    ['nested markers', `${startMarker}\n${startMarker}\n${endMarker}\n${endMarker}`],
  ]) {
    test(`refuses ${name} before changing HTML, backup, or existing assets`, (t) => {
      const fixture = createFixture(t);
      writeFileSync(fixture.window, fixture.original.toString('utf8')
        .replace('</body>', `${markers}\n</body>`));
      seedOwnedFolder(fixture);
      writeFileSync(fixture.backup, 'existing backup\n');
      for (const action of ['Install', 'Uninstall']) {
        assertFailureWithoutMutation(fixture, { action });
      }
    });
  }

  test('malformed fresh installs also fail in WhatIf without creating backup or assets', (t) => {
    const fixture = createFixture(t);
    writeFileSync(fixture.window, fixture.original.toString('utf8')
      .replace('</body>', `${startMarker}\n</body>`));
    assertFailureWithoutMutation(fixture);
    assertFailureWithoutMutation(fixture, { whatIf: true });
  });

  test('refuses owned markers outside the HTML body', (t) => {
    const fixture = createFixture(t);
    writeFileSync(fixture.window, fixture.original.toString('utf8')
      .replace('</head>', `${startMarker}\n${endMarker}\n</head>`));
    for (const action of ['Install', 'Uninstall']) {
      assertFailureWithoutMutation(fixture, { action });
    }
  });

  for (const [name, invalidHtml] of [
    ['empty HTML', ''],
    ['an unclosed HTML body', '<!DOCTYPE html><html><head></head><body><div></div></html>\n'],
    ['multiple HTML bodies', '<html><body></body><body></body></html>\n'],
  ]) {
    test(`refuses ${name} without mutation`, (t) => {
      const fixture = createFixture(t);
      writeFileSync(fixture.window, invalidHtml);
      seedOwnedFolder(fixture);
      for (const action of ['Install', 'Uninstall']) {
        assertFailureWithoutMutation(fixture, { action });
      }
    });
  }

  for (const ownership of [null, 'Someone else owns this folder.\n']) {
    test(`refuses an ${ownership === null ? 'unmarked' : 'incorrectly owned'} destination folder`, (t) => {
      const fixture = createFixture(t);
      mkdirSync(fixture.owned);
      writeFileSync(join(fixture.owned, 'keep.txt'), 'not ours\n');
      if (ownership !== null) writeFileSync(join(fixture.owned, '.owner'), ownership);
      for (const action of ['Install', 'Uninstall']) {
        assertFailureWithoutMutation(fixture, { action });
      }
    });
  }

  test('refuses a file where the owned folder would be created', (t) => {
    const fixture = createFixture(t);
    writeFileSync(fixture.owned, 'not a directory\n');
    for (const action of ['Install', 'Uninstall']) {
      assertFailureWithoutMutation(fixture, { action });
    }
  });

  test('refuses a junction at the owned folder without touching its target', (t) => {
    const fixture = createFixture(t);
    const protectedDirectory = join(fixture.root, 'junction target');
    mkdirSync(protectedDirectory);
    writeFileSync(join(protectedDirectory, '.owner'), owner);
    writeFileSync(join(protectedDirectory, 'keep.txt'), 'do not follow this junction\n');
    symlinkSync(protectedDirectory, fixture.owned, 'junction');
    for (const action of ['Install', 'Uninstall']) {
      assertFailureWithoutMutation(fixture, { action });
    }
  });

  test('refuses a junction occupying a known asset path', (t) => {
    const fixture = createFixture(t);
    seedOwnedFolder(fixture);
    const protectedDirectory = join(fixture.root, 'asset junction target');
    mkdirSync(protectedDirectory);
    writeFileSync(join(protectedDirectory, 'keep.txt'), 'do not delete\n');
    const asset = join(fixture.owned, 'constellation.js');
    unlinkSync(asset);
    symlinkSync(protectedDirectory, asset, 'junction');
    for (const action of ['Install', 'Uninstall']) {
      assertFailureWithoutMutation(fixture, { action });
    }
  });

  for (const name of ['.owner', 'constellation.js', 'backup']) {
    test(`refuses a symbolic link at ${name}`, (t) => {
      const fixture = createFixture(t);
      seedOwnedFolder(fixture);
      const protectedFile = join(fixture.root, 'symlink target.txt');
      writeFileSync(protectedFile, name === '.owner' ? owner : 'never overwrite or delete\n');
      const destination = name === 'backup' ? fixture.backup : join(fixture.owned, name);
      if (existsSync(destination)) unlinkSync(destination);
      try {
        symlinkSync(protectedFile, destination, 'file');
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
          t.skip('creating file symlinks requires Windows Developer Mode or an elevated token');
          return;
        }
        throw error;
      }
      for (const action of ['Install', 'Uninstall']) {
        assertFailureWithoutMutation(fixture, { action });
      }
    });
  }

  for (const name of assets.keys()) {
    test(`a missing source ${name} cannot partially overwrite an existing install`, (t) => {
      const fixture = createFixture(t);
      assertExit(runInstaller(fixture));
      const script = stageInstaller(fixture, [name]);
      assertFailureWithoutMutation(fixture, { script });
      assertInstalled(fixture);
    });
  }

  test('uninstall works from a script copy with all source assets absent', (t) => {
    const fixture = createFixture(t);
    assertExit(runInstaller(fixture));
    const script = stageInstaller(fixture, [...assets.keys()]);
    assertExit(runInstaller(fixture, { action: 'Uninstall', script }));
    assert.deepEqual(readFileSync(fixture.window), fixture.original);
    assert.deepEqual(readFileSync(fixture.backup), fixture.original);
    assert.ok(!existsSync(fixture.owned));
  });

  test('ignores a running Vivaldi from a different installation', async (t) => {
    const unrelated = createFixture(t);
    const fixture = createFixture(t);
    const child = await startFixtureVivaldi(unrelated);
    assertExit(runInstaller(fixture));
    assertInstalled(fixture);
    assertExit(runInstaller(fixture, { action: 'Uninstall' }));
    assert.deepEqual(readFileSync(fixture.window), fixture.original);
    assert.equal(child.exitCode, null, 'installer must not stop unrelated processes');
    assert.equal(child.signalCode, null);
  });

  test('blocks writes to a running target but still permits read-only WhatIf', async (t) => {
    const fixture = createFixture(t);
    assertExit(runInstaller(fixture));
    const child = await startFixtureVivaldi(fixture);
    for (const action of ['Install', 'Uninstall']) {
      const before = snapshotTree(fixture.root);
      assertExit(runInstaller(fixture, { action, whatIf: true }));
      assert.deepEqual(snapshotTree(fixture.root), before);
      const failure = assertFailureWithoutMutation(fixture, { action });
      assert.match(outputOf(failure), /running|quit/i);
    }
    assert.equal(child.exitCode, null, 'installer must not terminate the target browser');
    assert.equal(child.signalCode, null);
  });

  test('actual cmd launchers forward preview and quoted paths, pause once, and return success', (t) => {
    const fixture = createFixture(t);
    const before = snapshotTree(fixture.root);
    const preview = runLauncher(fixture, 'install.cmd', { whatIf: true, positional: true });
    assertExit(preview);
    assertPauseCount(preview, 1);
    assert.deepEqual(snapshotTree(fixture.root), before);
    const install = runLauncher(fixture, 'install.cmd', { positional: true });
    assertExit(install);
    assertPauseCount(install, 1);
    assertInstalled(fixture);
    const installed = snapshotTree(fixture.root);
    const uninstallPreview = runLauncher(fixture, 'uninstall.cmd', { whatIf: true });
    assertExit(uninstallPreview);
    assertPauseCount(uninstallPreview, 1);
    assert.deepEqual(snapshotTree(fixture.root), installed);
    const uninstall = runLauncher(fixture, 'uninstall.cmd');
    assertExit(uninstall);
    assertPauseCount(uninstall, 1);
    assert.deepEqual(readFileSync(fixture.window), fixture.original);
    assert.ok(!existsSync(fixture.owned));
  });

  test('actual cmd launchers preserve failing exit codes and pause only once on failure', (t) => {
    const fixture = createFixture(t);
    writeFileSync(fixture.window, fixture.original.toString('utf8')
      .replace('</body>', `${startMarker}\n</body>`));
    for (const launcher of ['install.cmd', 'uninstall.cmd']) {
      const before = snapshotTree(fixture.root);
      const result = runLauncher(fixture, launcher, { positional: true });
      assertExit(result, false);
      assertPauseCount(result, 1);
      assert.deepEqual(snapshotTree(fixture.root), before);
    }
  });
});
