import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
const directory = fileURLToPath(new URL('../', import.meta.url)),
  venv = resolve(directory, '.venv/bin/python3'),
  mode = process.argv[2] ?? 'install';
if (process.argv.length > 3 || !['install', '--check', '--offline', '--download'].includes(mode))
  throw new Error('prepare-pdf.ts [--check|--offline|--download]');
async function run(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
      stdio: 'inherit',
      env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' },
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(command + ' exited with ' + code)),
    );
  });
}
if (mode !== '--check') {
  await run(process.env.PREPARE_PYTHON ?? 'python3', ['-m', 'venv', '.venv']);
  if (mode === '--download') {
    mkdirSync(resolve(directory, '.cache/wheels'), { recursive: true });
    await run(venv, [
      '-m',
      'pip',
      'download',
      '-r',
      'requirements-pdf.txt',
      '--dest',
      '.cache/wheels',
    ]);
  } else {
    await run(venv, [
      '-m',
      'pip',
      'install',
      ...(mode === '--offline'
        ? ['--no-index', '--find-links', resolve(directory, '.cache/wheels')]
        : []),
      '-r',
      'requirements-pdf.txt',
    ]);
    if (process.platform === 'darwin') {
      mkdirSync(resolve(directory, '.cache'), { recursive: true });
      const temporary = mkdtempSync(resolve(directory, '.cache/vision-build-'));
      try {
        await run('swiftc', [
          '-module-cache-path',
          join(temporary, 'modules'),
          'scripts/ocr-vision.swift',
          '-o',
          join(temporary, 'ocr-vision'),
        ]);
        renameSync(join(temporary, 'ocr-vision'), resolve(directory, '.cache/ocr-vision'));
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
  }
}
if (mode !== '--download') {
  if (!existsSync(venv)) throw new Error('PDF runtime is missing. Run yarn prepare:pdf.');
  await run(venv, ['-c', 'import pdfplumber,pypdfium2;print("Local PDF runtime ready")']);
  if (process.platform === 'darwin') {
    if (!existsSync(resolve(directory, '.cache/ocr-vision')))
      throw new Error('Local OCR binary is missing. Run yarn prepare:pdf.');
    console.log('Local Apple Vision OCR ready.');
  } else await run('tesseract', ['--list-langs']);
}
