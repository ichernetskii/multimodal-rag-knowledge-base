import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { serverExecutable, serverPath } from '../../config/paths.js';
export function pythonCommand() {
  return process.env.PDF_PYTHON
    ? serverExecutable(process.env.PDF_PYTHON)
    : existsSync(serverPath('.venv/bin/python3'))
      ? serverPath('.venv/bin/python3')
      : 'python3';
}
export function visionCommand() {
  const path = process.env.OCR_VISION_BIN
    ? serverExecutable(process.env.OCR_VISION_BIN)
    : process.platform === 'darwin'
      ? serverPath('.cache/ocr-vision')
      : undefined;
  if (!path) return undefined;
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}
async function probe(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] }),
      timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    let output = '';
    child.stdout.on('data', (bytes: Buffer) => {
      output += bytes.toString();
      if (output.length > 65536) child.kill('SIGKILL');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error('Dependency unavailable'));
    });
  });
}
export async function extractionHealth(language = 'eng') {
  const pdf = await probe(pythonCommand(), ['-c', 'import pdfplumber,pypdfium2']).then(
    () => true,
    () => false,
  );
  if (visionCommand())
    return { pdf, ocr: true, backend: 'apple-vision' as const, languages: [] as string[] };
  const output = await probe('tesseract', ['--list-langs']).catch(() => null);
  const languages =
    output
      ?.split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean) ?? [];
  return {
    pdf,
    ocr: output !== null && language.split('+').every((value) => languages.includes(value)),
    backend: output === null ? ('unavailable' as const) : ('tesseract' as const),
    languages,
  };
}
