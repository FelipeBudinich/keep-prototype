import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const FFMPEG_MISSING_MESSAGE = 'music-atlas requires ffmpeg in PATH to bake packed music audio.';
const BYTES_PER_SAMPLE = 2;
const DEFAULT_OUTPUT_DIR = 'assets';
const SILENCE_CHUNK_BYTES = 1024 * 1024;

const DEFAULT_SOURCE_FORMAT_PREFERENCE = ['wav', 'ogg', 'mp3', 'm4a', 'webm', 'caf'];

const toPosixPath = (value) => value.split(path.sep).join('/').replace(/\\/g, '/');

const normalizePublicPath = (value) =>
  toPosixPath(String(value || '')).replace(/^\.\//, '').replace(/^\/+/, '');

const joinPublicPath = (...parts) =>
  parts.map((part) => normalizePublicPath(part)).filter(Boolean).join('/');

const joinPublicBase = (base, fileName) => {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  return `${normalizedBase}${normalizePublicPath(fileName)}`;
};

const escapeInlineScriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

const buildMusicAtlasManifestAssignment = (manifest) =>
  `globalThis.__THESEUS_MUSIC_ATLAS_MANIFEST__ = ${escapeInlineScriptJson(manifest)};`;

const roundSeconds = (seconds) => Number(seconds.toFixed(6));

const getExtension = (filePath) => path.extname(filePath).slice(1).toLowerCase();

const getStem = (filePath) => {
  const extension = path.posix.extname(filePath);
  return extension ? filePath.slice(0, -extension.length) : filePath;
};

const collectMusicSourceFiles = async (
  absoluteDirectory,
  projectRoot,
  sourceFormatPreference = DEFAULT_SOURCE_FORMAT_PREFERENCE,
) => {
  const supportedExtensions = new Set(sourceFormatPreference.map((extension) => extension.toLowerCase()));
  const directoryEntries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  directoryEntries.sort((left, right) => left.name.localeCompare(right.name));

  const results = [];

  for (const directoryEntry of directoryEntries) {
    const absolutePath = path.join(absoluteDirectory, directoryEntry.name);

    if (directoryEntry.isDirectory()) {
      const nestedResults = await collectMusicSourceFiles(
        absolutePath,
        projectRoot,
        sourceFormatPreference,
      );
      results.push(...nestedResults);
      continue;
    }

    const extension = getExtension(directoryEntry.name);
    if (!supportedExtensions.has(extension)) {
      continue;
    }

    const publicPath = normalizePublicPath(path.relative(projectRoot, absolutePath));
    results.push({
      absolutePath,
      path: publicPath,
      extension,
      stem: getStem(publicPath),
    });
  }

  return results;
};

const compareMusicSources = (preferenceRanks) => (left, right) => {
  const leftRank = preferenceRanks.get(left.extension) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = preferenceRanks.get(right.extension) ?? Number.MAX_SAFE_INTEGER;

  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return left.path.localeCompare(right.path);
};

const groupMusicSources = (
  sourceFiles,
  sourceFormatPreference = DEFAULT_SOURCE_FORMAT_PREFERENCE,
) => {
  const preferenceRanks = new Map(
    sourceFormatPreference.map((extension, index) => [extension.toLowerCase(), index]),
  );
  const groups = new Map();

  for (const sourceFile of sourceFiles) {
    const stem = normalizePublicPath(sourceFile.stem || getStem(sourceFile.path));
    const variant = {
      ...sourceFile,
      path: normalizePublicPath(sourceFile.path),
      extension: (sourceFile.extension || getExtension(sourceFile.path)).toLowerCase(),
      stem,
    };
    const existingGroup = groups.get(stem) || { stem, variants: [] };
    existingGroup.variants.push(variant);
    groups.set(stem, existingGroup);
  }

  return [...groups.values()]
    .map((group) => {
      const variants = [...group.variants].sort(compareMusicSources(preferenceRanks));

      return {
        stem: group.stem,
        variants,
        source: variants[0],
      };
    })
    .sort((left, right) => left.stem.localeCompare(right.stem));
};

const createMusicAliasEntries = ({ group, atlasIndex, start, duration }) => {
  const entry = {
    atlas: atlasIndex,
    start: roundSeconds(start),
    duration: roundSeconds(duration),
    source: group.source.path,
  };
  const aliases = [`${group.stem}.*`, ...group.variants.map((variant) => variant.path)];

  return aliases.map((alias) => [alias, { ...entry }]);
};

const runProcess = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      settled = true;
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const commandText = [command, ...args].join(' ');
      reject(
        new Error(
          `${commandText} failed${signal ? ` with signal ${signal}` : ` with code ${code}`}\n${stderr}${stdout}`,
        ),
      );
    });
  });

const ensureFfmpegAvailable = async () => {
  try {
    await runProcess('ffmpeg', ['-version']);
  }
  catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(FFMPEG_MISSING_MESSAGE);
    }

    throw error;
  }
};

const decodeToRawPcmFile = async ({ inputPath, outputPath, channels, sampleRate }) => {
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-ac',
    String(channels),
    '-ar',
    String(sampleRate),
    '-f',
    's16le',
    outputPath,
  ]);

  const stats = await fs.stat(outputPath);
  const frames = stats.size / (channels * BYTES_PER_SAMPLE);

  return {
    path: outputPath,
    bytes: stats.size,
    frames,
    duration: frames / sampleRate,
  };
};

const appendFileToFile = async (sourcePath, destinationPath) => {
  await pipeline(
    createReadStream(sourcePath),
    createWriteStream(destinationPath, { flags: 'a' }),
  );
};

const writeSilenceFrames = async ({ outputPath, frames, channels }) => {
  let remainingBytes = Math.max(0, frames) * channels * BYTES_PER_SAMPLE;
  if (!remainingBytes) {
    return;
  }

  const fileHandle = await fs.open(outputPath, 'a');
  try {
    const silence = Buffer.alloc(Math.min(SILENCE_CHUNK_BYTES, remainingBytes));

    while (remainingBytes > 0) {
      const bytesToWrite = Math.min(silence.length, remainingBytes);
      await fileHandle.write(silence, 0, bytesToWrite);
      remainingBytes -= bytesToWrite;
    }
  }
  finally {
    await fileHandle.close();
  }
};

const encodeAtlasFormat = async ({ inputPath, outputPath, format, channels, sampleRate }) => {
  const formatOptions = {
    ogg: ['-c:a', 'libvorbis', '-q:a', '5'],
    mp3: ['-c:a', 'libmp3lame', '-q:a', '4'],
  }[format];

  if (!formatOptions) {
    throw new Error(`Unsupported music atlas output format "${format}".`);
  }

  await runProcess('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    's16le',
    '-ac',
    String(channels),
    '-ar',
    String(sampleRate),
    '-i',
    inputPath,
    ...formatOptions,
    outputPath,
  ]);
};

const buildRuntimeManifest = ({
  publicBase,
  outputDir,
  atlasName,
  formats,
  sampleRate,
  channels,
  paddingSeconds,
  atlasDuration,
  trackPlacements,
}) => {
  const atlasFormats = {};

  for (const format of formats) {
    const atlasFileName = joinPublicPath(outputDir, `${atlasName}.${format}`);
    atlasFormats[format] = joinPublicBase(publicBase, atlasFileName);
  }

  const manifest = {
    version: 1,
    sampleRate,
    channels,
    padding: roundSeconds(paddingSeconds),
    atlases: [
      {
        formats: atlasFormats,
        duration: roundSeconds(atlasDuration),
      },
    ],
    tracks: {},
  };

  for (const placement of trackPlacements) {
    const aliasEntries = createMusicAliasEntries({
      group: placement.group,
      atlasIndex: 0,
      start: placement.start,
      duration: placement.duration,
    });

    for (const [alias, entry] of aliasEntries) {
      manifest.tracks[alias] = entry;
    }
  }

  return manifest;
};

const packMusicAtlasForBuild = async ({
  projectRoot,
  publicBase = '/',
  sourceDir = 'games/example/media/music',
  atlasName = 'music-atlas',
  outputDir = DEFAULT_OUTPUT_DIR,
  formats = ['ogg', 'mp3'],
  sampleRate = 44100,
  channels = 2,
  paddingSeconds = 1.0,
  sourceFormatPreference = DEFAULT_SOURCE_FORMAT_PREFERENCE,
} = {}) => {
  const resolvedProjectRoot = projectRoot || process.cwd();
  const absoluteSourceDirectory = path.join(resolvedProjectRoot, sourceDir);

  let sourceDirectoryStats;
  try {
    sourceDirectoryStats = await fs.stat(absoluteSourceDirectory);
  }
  catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  if (!sourceDirectoryStats.isDirectory()) {
    return null;
  }

  const sourceFiles = await collectMusicSourceFiles(
    absoluteSourceDirectory,
    resolvedProjectRoot,
    sourceFormatPreference,
  );
  if (!sourceFiles.length) {
    return null;
  }

  await ensureFfmpegAvailable();

  const groups = groupMusicSources(sourceFiles, sourceFormatPreference);
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'theseus-music-atlas-'));

  try {
    const rawAtlasPath = path.join(tempDirectory, `${atlasName}.raw`);
    const paddingFrames = Math.max(0, Math.round(paddingSeconds * sampleRate));
    const trackPlacements = [];
    let currentFrame = 0;

    await fs.writeFile(rawAtlasPath, Buffer.alloc(0));
    await writeSilenceFrames({
      outputPath: rawAtlasPath,
      frames: paddingFrames,
      channels,
    });
    currentFrame += paddingFrames;

    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      const rawOutputPath = path.join(tempDirectory, `clip-${index}.raw`);
      const decodedClip = await decodeToRawPcmFile({
        inputPath: group.source.absolutePath,
        outputPath: rawOutputPath,
        channels,
        sampleRate,
      });
      const start = currentFrame / sampleRate;
      const duration = decodedClip.frames / sampleRate;

      trackPlacements.push({
        group,
        start,
        duration,
      });

      await appendFileToFile(decodedClip.path, rawAtlasPath);
      currentFrame += decodedClip.frames;
      await writeSilenceFrames({
        outputPath: rawAtlasPath,
        frames: paddingFrames,
        channels,
      });
      currentFrame += paddingFrames;
    }

    const normalizedOutputDir = normalizePublicPath(outputDir);
    const normalizedFormats = formats.map((format) => format.toLowerCase());
    const atlasAssets = [];

    for (const format of normalizedFormats) {
      const outputPath = path.join(tempDirectory, `${atlasName}.${format}`);
      await encodeAtlasFormat({
        inputPath: rawAtlasPath,
        outputPath,
        format,
        channels,
        sampleRate,
      });
      atlasAssets.push({
        fileName: joinPublicPath(normalizedOutputDir, `${atlasName}.${format}`),
        source: await fs.readFile(outputPath),
      });
    }

    return {
      atlasAssets,
      manifest: buildRuntimeManifest({
        publicBase,
        outputDir: normalizedOutputDir,
        atlasName,
        formats: normalizedFormats,
        sampleRate,
        channels,
        paddingSeconds,
        atlasDuration: currentFrame / sampleRate,
        trackPlacements,
      }),
    };
  }
  finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
};

const createMusicAtlasPlugin = (options = {}) => {
  const {
    emitManifestFile = false,
    manifestFileName = null,
    injectManifestIntoHtml = true,
    prependManifestToJavaScript = false,
    prependManifestToAllJavaScriptChunks = true,
    ...musicAtlasOptions
  } = options;

  let resolvedConfig = null;
  let musicAtlasBuildPromise = null;
  let assetsEmitted = false;

  const ensureMusicAtlas = async () => {
    if (!musicAtlasBuildPromise) {
      if (!resolvedConfig) {
        throw new Error('Music atlas plugin has not received the resolved Vite config yet.');
      }

      musicAtlasBuildPromise = packMusicAtlasForBuild({
        projectRoot: resolvedConfig.root,
        publicBase: resolvedConfig.base,
        ...musicAtlasOptions,
      });
    }

    return musicAtlasBuildPromise;
  };

  return {
    name: 'vite-plugin-theseus-music-atlas',
    apply: 'build',

    configResolved(config) {
      resolvedConfig = config;
    },

    async buildStart() {
      const musicAtlasBuild = await ensureMusicAtlas();
      if (!musicAtlasBuild || assetsEmitted) {
        return;
      }

      for (const atlasAsset of musicAtlasBuild.atlasAssets) {
        this.emitFile({
          type: 'asset',
          fileName: atlasAsset.fileName,
          source: atlasAsset.source,
        });
      }

      if (emitManifestFile) {
        this.emitFile({
          type: 'asset',
          fileName: normalizePublicPath(
            manifestFileName
              ?? joinPublicPath(musicAtlasOptions.outputDir ?? DEFAULT_OUTPUT_DIR, 'music-atlas-manifest.json'),
          ),
          source: JSON.stringify(musicAtlasBuild.manifest, null, 2),
        });
      }

      assetsEmitted = true;
    },

    async renderChunk(code, chunk) {
      if (!prependManifestToJavaScript) {
        return null;
      }

      if (!prependManifestToAllJavaScriptChunks && !chunk.isEntry) {
        return null;
      }

      const musicAtlasBuild = await ensureMusicAtlas();
      if (!musicAtlasBuild) {
        return null;
      }

      return {
        code: `${buildMusicAtlasManifestAssignment(musicAtlasBuild.manifest)}\n${code}`,
        map: null,
      };
    },

    async transformIndexHtml(html) {
      if (!injectManifestIntoHtml) {
        return html;
      }

      const musicAtlasBuild = await ensureMusicAtlas();
      if (!musicAtlasBuild) {
        return html;
      }

      return {
        html,
        tags: [
          {
            tag: 'script',
            injectTo: 'head-prepend',
            children: buildMusicAtlasManifestAssignment(musicAtlasBuild.manifest),
          },
        ],
      };
    },
  };
};

const __private__ = {
  FFMPEG_MISSING_MESSAGE,
  appendFileToFile,
  buildMusicAtlasManifestAssignment,
  buildRuntimeManifest,
  collectMusicSourceFiles,
  createMusicAliasEntries,
  decodeToRawPcmFile,
  encodeAtlasFormat,
  ensureFfmpegAvailable,
  escapeInlineScriptJson,
  groupMusicSources,
  joinPublicBase,
  joinPublicPath,
  normalizePublicPath,
  roundSeconds,
  runProcess,
  toPosixPath,
  writeSilenceFrames,
};

export { createMusicAtlasPlugin, packMusicAtlasForBuild, __private__ };
