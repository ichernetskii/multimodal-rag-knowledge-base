export interface DownloadAsset {
  url: string;
  sha256: string;
  maxBytes: number;
}
export const mediaBuildVersion = 'ffmpeg-9.0.2-whisper-1.9.1-cpu-v2';
export const ffmpegSource: DownloadAsset = {
  url: 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.gz',
  sha256: '84960df915059e8754fef2cd7c9afeb614062b1b5458ec471eecee619ee04e98',
  maxBytes: 32_000_000,
};
export const x264Source: DownloadAsset = {
  url: 'https://deb.debian.org/debian/pool/main/x/x264/x264_0.164.3095+gitbaee400.orig.tar.gz',
  sha256: '8b237e94b08c196a1da22f2f25875f10be4cff3648df4eeff21e00da8f683fc2',
  maxBytes: 2000000,
};
export const whisperSource: DownloadAsset = {
  url: 'https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/f049fff95a089aa9969deb009cdd4892b3e74916',
  sha256: '279af4ce60dbf397362868f3bacc75b56a4332ac2541cae155070093f6aaf0e3',
  maxBytes: 16_000_000,
};
export const whisperSmall: DownloadAsset = {
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
  sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
  maxBytes: 487601967,
};
export function cmakeAsset(
  platform = process.platform,
  arch = process.arch,
): DownloadAsset & { command: string } {
  const system =
    platform === 'darwin'
      ? 'macos-universal'
      : platform === 'linux' && arch === 'x64'
        ? 'linux-x86_64'
        : platform === 'linux' && arch === 'arm64'
          ? 'linux-aarch64'
          : '';
  const sums: Record<string, string> = {
    'macos-universal': '4b7b73704b1db9b374e5c9ab8e17ac6148b817b6396ee75cd94a852cbac9d305',
    'linux-x86_64': 'e5bb807f7728cb60cd8b27ebc97a2edb469b68655f21e844a600c3575b76f5bb',
    'linux-aarch64': 'a1b6cc63636a0e55c63257cf3315a8a5f129e42fade25db1afea4ff8ab06f25e',
  };
  const sha256 = sums[system];
  if (!sha256)
    throw new Error(
      'Native preparation supports macOS/Linux x64/arm64. Use Docker/WSL2 on Windows.',
    );
  return {
    url: `https://github.com/Kitware/CMake/releases/download/v4.4.4/cmake-4.4.4-${system}.tar.gz`,
    sha256,
    maxBytes: 100_000_000,
    command: platform === 'darwin' ? 'CMake.app/Contents/bin/cmake' : 'bin/cmake',
  };
}
