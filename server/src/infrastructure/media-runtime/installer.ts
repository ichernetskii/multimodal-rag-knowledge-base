import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { mediaRuntimeDirectory, defaultWhisperModel } from '../../config/media-runtime.js';
import { serverPath } from '../../config/paths.js';
import { digestFile, downloadVerified, matchesAsset } from './download.js';
import {
  cmakeAsset,
  ffmpegSource,
  x264Source,
  mediaBuildVersion,
  whisperSmall,
  whisperSource,
} from './manifest.js';
interface Receipt {
  version: string;
  platform: string;
  arch: string;
  files: Record<string, string>;
}
export interface PrepareMediaOptions {
  directory?: string;
  modelPath?: string;
  offline?: boolean;
  check?: boolean;
  toolsOnly?: boolean;
  signal?: AbortSignal;
  log?: (text: string) => void;
}
const executables = ['ffmpeg', 'ffprobe', 'whisper-cli'];
async function requireOwnedDirectory(directory: string) {
  try {
    await stat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  let owned = false;
  try {
    const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8')) as Receipt;
    owned =
      /^ffmpeg-[\d.]+-whisper-[\d.]+-cpu-v\d+$/u.test(receipt.version) &&
      executables.every((name) => /^[a-f0-9]{64}$/u.test(receipt.files[name] ?? ''));
  } catch {
    /* An unrelated directory is never replaced by the installer. */
  }
  if (!owned)
    throw new Error(
      'MEDIA_RUNTIME_DIR занят каталогом без метки установки Local RAG. Выберите новый пустой путь; существующие данные не изменены.',
    );
}
async function toolsReady(directory: string) {
  try {
    const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8')) as Receipt;
    if (
      receipt.version !== mediaBuildVersion ||
      receipt.platform !== process.platform ||
      receipt.arch !== process.arch
    )
      return false;
    for (const name of executables) {
      const path = join(directory, 'bin', name);
      if (!(await stat(path)).isFile() || (await digestFile(path)) !== receipt.files[name])
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
async function run(command: string, args: string[], cwd: string, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PKG_CONFIG_PATH:
          join(cwd, '../x264-install/lib/pkgconfig') +
          (process.env.PKG_CONFIG_PATH ? ':' + process.env.PKG_CONFIG_PATH : ''),
      },
    });
    let tail = '';
    const output = (value: Buffer) => {
      tail = (tail + value.toString()).slice(-6000);
    };
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    const abort = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      signal.removeEventListener('abort', abort);
      reject(
        new Error(
          `Не удалось запустить ${command}: ${error.message}. Для нативной сборки нужны C/C++ compiler, make и tar; готовая поставка Docker включает инструменты.`,
        ),
      );
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted)
        reject(new Error('Подготовка медиа отменена или превысила лимит времени.'));
      else if (code !== 0)
        reject(new Error(`Сборка ${command} завершилась с кодом ${code}:\n${tail}`));
      else resolve();
    });
  });
}
async function buildTools(
  directory: string,
  offline: boolean,
  signal: AbortSignal,
  log: (text: string) => void,
) {
  await requireOwnedDirectory(directory);
  if (!['darwin', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch))
    throw new Error('Для этой ОС/архитектуры используйте Docker/WSL2.');
  const cache = serverPath('.cache/media-downloads');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const ffmpeg = join(cache, 'ffmpeg-9.0.2.tar.gz'),
    whisper = join(cache, 'whisper-1.9.1.tar.gz'),
    x264 = join(cache, 'x264-baee400.tar.gz');
  log('Подготовка исходников FFmpeg и whisper.cpp (SHA-256).');
  await downloadVerified(x264, x264Source, { offline, signal });
  await downloadVerified(ffmpeg, ffmpegSource, { offline, signal });
  await downloadVerified(whisper, whisperSource, { offline, signal });
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(dirname(directory), 'media-build-'));
  try {
    const ffmpegDir = join(work, 'ffmpeg'),
      whisperDir = join(work, 'whisper'),
      x264Dir = join(work, 'x264'),
      x264Install = join(work, 'x264-install'),
      output = join(work, 'runtime'),
      bin = join(output, 'bin');
    for (const path of [ffmpegDir, whisperDir, bin, x264Dir])
      await mkdir(path, { recursive: true });
    await run('tar', ['-xzf', ffmpeg, '--strip-components=1', '-C', ffmpegDir], work, signal);
    await run('tar', ['-xzf', whisper, '--strip-components=1', '-C', whisperDir], work, signal);
    await run('tar', ['-xzf', x264, '--strip-components=1', '-C', x264Dir], work, signal);
    let cmake = process.env.CMAKE_BIN;
    if (!cmake) {
      const asset = cmakeAsset(),
        archive = join(cache, `cmake-4.4.4-${process.platform}-${process.arch}.tar.gz`),
        cmakeDir = join(work, 'cmake');
      await downloadVerified(archive, asset, { offline, signal });
      await mkdir(cmakeDir);
      await run('tar', ['-xzf', archive, '--strip-components=1', '-C', cmakeDir], work, signal);
      cmake = join(cmakeDir, asset.command);
    }
    const threads = String(Math.min(4, Math.max(1, cpus().length)));
    await run(
      './configure',
      [
        '--prefix=' + x264Install,
        '--enable-static',
        '--disable-cli',
        '--disable-asm',
        '--enable-pic',
      ],
      x264Dir,
      signal,
    );
    await run('make', ['-j', threads], x264Dir, signal);
    await run('make', ['install'], x264Dir, signal);
    log('Сборка собственного FFmpeg (первый запуск может занять несколько минут).');
    await run(
      './configure',
      [
        '--enable-gpl',
        '--enable-libx264',
        '--extra-cflags=-I' + join(x264Install, 'include'),
        '--extra-ldflags=-L' + join(x264Install, 'lib'),
        '--pkg-config-flags=--static',
        '--extra-libs=-lpthread -lm',
        '--disable-doc',
        '--disable-debug',
        '--disable-ffplay',
        '--disable-autodetect',
        '--disable-network',
        '--disable-x86asm',
        '--disable-shared',
        '--enable-static',
        '--disable-everything',
        '--enable-ffmpeg',
        '--enable-ffprobe',
        '--enable-protocol=file,pipe',
        '--enable-demuxer=mov,matroska,wav,mp3,flac,ogg,image2,jpeg_pipe,png_pipe,webp_pipe',
        '--enable-decoder=h264,hevc,mpeg4,vp8,vp9,aac,mp3,flac,opus,vorbis,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,mjpeg,png,webp',
        '--enable-parser=h264,hevc,mpeg4video,vp8,vp9,aac,mpegaudio,flac,opus,vorbis,mjpeg,png',
        '--enable-encoder=mjpeg,pcm_s16le,mpeg4,aac,libx264',
        '--enable-muxer=image2,wav,mp4',
        '--enable-filter=scale,format,aresample,anull,null,aformat,transpose,hflip,vflip,trim,atrim,setpts,asetpts,fps',
        '--enable-zlib',
      ],
      ffmpegDir,
      signal,
    );
    await run('make', ['-j', threads, 'ffmpeg', 'ffprobe'], ffmpegDir, signal);
    for (const name of ['ffmpeg', 'ffprobe'])
      await copyFile(join(ffmpegDir, name), join(bin, name));
    log('Сборка собственной whisper.cpp (CPU).');
    await run(
      cmake,
      [
        '-S',
        whisperDir,
        '-B',
        join(work, 'whisper-build'),
        '-DCMAKE_BUILD_TYPE=Release',
        '-DBUILD_SHARED_LIBS=OFF',
        '-DGGML_NATIVE=OFF',
        '-DGGML_METAL=OFF',
        '-DGGML_OPENMP=OFF',
        '-DWHISPER_BUILD_TESTS=OFF',
      ],
      work,
      signal,
    );
    await run(
      cmake,
      ['--build', join(work, 'whisper-build'), '--target', 'whisper-cli', '-j', threads],
      work,
      signal,
    );
    await copyFile(join(work, 'whisper-build/bin/whisper-cli'), join(bin, 'whisper-cli'));
    const files: Record<string, string> = {};
    for (const name of executables) {
      const path = join(bin, name);
      await chmod(path, 0o755);
      await run(path, [name === 'whisper-cli' ? '--help' : '-version'], work, signal);
      files[name] = await digestFile(path);
    }
    const licenses = join(output, 'licenses');
    await mkdir(licenses);
    await copyFile(join(whisperDir, 'LICENSE'), join(licenses, 'whisper-MIT.txt'));
    await copyFile(join(ffmpegDir, 'COPYING.GPLv2'), join(licenses, 'ffmpeg-GPLv2.txt'));
    await copyFile(join(x264Dir, 'COPYING'), join(licenses, 'x264-GPLv2.txt'));
    const sources = join(output, 'sources');
    await mkdir(sources);
    for (const source of [ffmpeg, whisper, x264])
      await copyFile(source, join(sources, source.split('/').at(-1)!));
    await writeFile(
      join(output, 'receipt.json'),
      JSON.stringify({
        version: mediaBuildVersion,
        platform: process.platform,
        arch: process.arch,
        files,
      }),
      { mode: 0o600 },
    );
    const old = directory + '.previous-' + randomUUID();
    try {
      await rename(directory, old);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await rename(output, directory);
    } catch (error) {
      await rename(old, directory).catch(() => {});
      throw error;
    }
    await rm(old, { recursive: true, force: true });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
export async function prepareMediaRuntime(options: PrepareMediaOptions = {}) {
  const directory = options.directory ?? mediaRuntimeDirectory(),
    modelPath = options.modelPath ?? defaultWhisperModel(),
    offline = options.offline ?? process.env.MEDIA_OFFLINE === '1',
    log = options.log ?? console.log;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signal = AbortSignal.any([
    controller.signal,
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(1800_000),
  ]);
  if (options.check) {
    if (
      !(await toolsReady(directory)) ||
      (!options.toolsOnly && !(await matchesAsset(modelPath, whisperSmall)))
    )
      throw new Error(
        'Управляемый media runtime отсутствует или повреждён. Выполните yarn prepare:media.',
      );
    return { directory, modelPath, changed: false };
  }
  if (
    (await toolsReady(directory)) &&
    (options.toolsOnly || (await matchesAsset(modelPath, whisperSmall)))
  ) {
    log('Серверный media runtime проверен; скачивание не требуется.');
    return { directory, modelPath, changed: false };
  }
  await mkdir(dirname(modelPath), { recursive: true, mode: 0o700 });
  const lock = modelPath + '.install-lock';
  for (;;) {
    signal.throwIfAborted();
    try {
      await mkdir(lock);
      await writeFile(join(lock, 'pid'), String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(join(lock, 'pid'), 'utf8').catch(() => '0'));
      if (pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
            await rm(lock, { recursive: true, force: true });
            continue;
          }
        }
      }
      if (!pid && Date.now() - (await stat(lock)).mtimeMs > 30_000) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  try {
    let changed = false;
    if (!(await toolsReady(directory))) {
      await buildTools(directory, offline, signal, log);
      changed = true;
    }
    if (!options.toolsOnly) {
      if (!(await matchesAsset(modelPath, whisperSmall)))
        log('Подготовка Whisper small multilingual (488 МБ, SHA-256).');
      changed = (await downloadVerified(modelPath, whisperSmall, { offline, signal })) || changed;
    }
    log(
      changed
        ? 'Серверный media runtime подготовлен.'
        : 'Серверный media runtime проверен; скачивание не требуется.',
    );
    return { directory, modelPath, changed };
  } finally {
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
    await rm(lock, { recursive: true, force: true });
  }
}
