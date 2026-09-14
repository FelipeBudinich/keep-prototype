import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const FFMPEG_MISSING_MESSAGE = 'sfx-atlas requires ffmpeg in PATH to bake packed SFX audio.';
const BYTES_PER_SAMPLE = 2;
const DEFAULT_OUTPUT_DIR = 'assets';

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

const buildSfxAtlasManifestAssignment = (manifest) =>
  `globalThis.__THESEUS_SFX_ATLAS_MANIFEST__ = ${escapeInlineScriptJson(manifest)};`;

const roundSeconds = (seconds) => Number(seconds.toFixed(6));

const getExtension = (filePath) => path.extname(filePath).slice(1).toLowerCase();

const getStem = (filePath) => {
  const extension = path.posix.extname(filePath);
  return extension ? filePath.slice(0, -extension.length) : filePath;
};

const collectSfxSourceFiles = async (
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
      const nestedResults = await collectSfxSourceFiles(
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

const compareSfxSources = (preferenceRanks) => (left, right) => {
  const leftRank = preferenceRanks.get(left.extension) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = preferenceRanks.get(right.extension) ?? Number.MAX_SAFE_INTEGER;

  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return left.path.localeCompare(right.path);
};

const groupSfxSources = (
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
      const variants = [...group.variants].sort(compareSfxSources(preferenceRanks));

      return {
        stem: group.stem,
        variants,
        source: variants[0],
      };
    })
    .sort((left, right) => left.stem.localeCompare(right.stem));
};

const createSfxAliasEntries = ({ group, atlasIndex, start, duration }) => {
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

const decodeToRawPcm = async ({ inputPath, outputPath, channels, sampleRate }) => {
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

  const pcm = await fs.readFile(outputPath);
  const frames = pcm.length / (channels * BYTES_PER_SAMPLE);

  return { pcm, frames, duration: frames / sampleRate };
};

const createWavBuffer = ({ pcm, sampleRate, channels }) => {
  const blockAlign = channels * BYTES_PER_SAMPLE;
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(44 + pcm.length);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + pcm.length, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(pcm.length, 40);
  pcm.copy(buffer, 44);

  return buffer;
};

const encodeAtlasFormat = async ({ inputPath, outputPath, format }) => {
  const formatOptions = {
    ogg: ['-c:a', 'libvorbis', '-q:a', '5'],
    mp3: ['-c:a', 'libmp3lame', '-q:a', '4'],
  }[format];

  if (!formatOptions) {
    throw new Error(`Unsupported SFX atlas output format "${format}".`);
  }

  await runProcess('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    ...formatOptions,
    outputPath,
  ]);
};

const buildPaddedAtlasPcm = ({ decodedClips, groups, sampleRate, channels, paddingSeconds }) => {
  const paddingFrames = Math.max(0, Math.round(paddingSeconds * sampleRate));
  const silence = Buffer.alloc(paddingFrames * channels * BYTES_PER_SAMPLE);
  const parts = [silence];
  let currentFrame = paddingFrames;
  const clipPlacements = [];

  for (let index = 0; index < decodedClips.length; index++) {
    const decodedClip = decodedClips[index];
    const start = currentFrame / sampleRate;
    const duration = decodedClip.frames / sampleRate;

    clipPlacements.push({
      group: groups[index],
      start,
      duration,
    });

    parts.push(decodedClip.pcm);
    currentFrame += decodedClip.frames;
    parts.push(silence);
    currentFrame += paddingFrames;
  }

  return {
    pcm: Buffer.concat(parts),
    clipPlacements,
    duration: currentFrame / sampleRate,
  };
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
  clipPlacements,
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
    sounds: {},
  };

  for (const placement of clipPlacements) {
    const aliasEntries = createSfxAliasEntries({
      group: placement.group,
      atlasIndex: 0,
      start: placement.start,
      duration: placement.duration,
    });

    for (const [alias, entry] of aliasEntries) {
      manifest.sounds[alias] = entry;
    }
  }

  return manifest;
};

const packSfxAtlasForBuild = async ({
  projectRoot,
  publicBase = '/',
  sourceDir = 'games/example/media/sounds',
  atlasName = 'sfx-atlas',
  outputDir = DEFAULT_OUTPUT_DIR,
  formats = ['ogg', 'mp3'],
  sampleRate = 44100,
  channels = 2,
  paddingSeconds = 0.05,
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

  const sourceFiles = await collectSfxSourceFiles(
    absoluteSourceDirectory,
    resolvedProjectRoot,
    sourceFormatPreference,
  );
  if (!sourceFiles.length) {
    return null;
  }

  await ensureFfmpegAvailable();

  const groups = groupSfxSources(sourceFiles, sourceFormatPreference);
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'theseus-sfx-atlas-'));

  try {
    const decodedClips = [];

    for (let index = 0; index < groups.length; index++) {
      const rawOutputPath = path.join(tempDirectory, `clip-${index}.raw`);
      decodedClips.push(await decodeToRawPcm({
        inputPath: groups[index].source.absolutePath,
        outputPath: rawOutputPath,
        channels,
        sampleRate,
      }));
    }

    const atlasPcm = buildPaddedAtlasPcm({
      decodedClips,
      groups,
      sampleRate,
      channels,
      paddingSeconds,
    });
    const wavPath = path.join(tempDirectory, `${atlasName}.wav`);
    await fs.writeFile(wavPath, createWavBuffer({
      pcm: atlasPcm.pcm,
      sampleRate,
      channels,
    }));

    const normalizedOutputDir = normalizePublicPath(outputDir);
    const atlasAssets = [];

    for (const format of formats) {
      const normalizedFormat = format.toLowerCase();
      const outputPath = path.join(tempDirectory, `${atlasName}.${normalizedFormat}`);
      await encodeAtlasFormat({
        inputPath: wavPath,
        outputPath,
        format: normalizedFormat,
      });
      atlasAssets.push({
        fileName: joinPublicPath(normalizedOutputDir, `${atlasName}.${normalizedFormat}`),
        source: await fs.readFile(outputPath),
      });
    }

    return {
      atlasAssets,
      manifest: buildRuntimeManifest({
        publicBase,
        outputDir: normalizedOutputDir,
        atlasName,
        formats: formats.map((format) => format.toLowerCase()),
        sampleRate,
        channels,
        paddingSeconds,
        atlasDuration: atlasPcm.duration,
        clipPlacements: atlasPcm.clipPlacements,
      }),
    };
  }
  finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
};

const createSfxAtlasPlugin = (options = {}) => {
  const {
    emitManifestFile = false,
    manifestFileName = null,
    injectManifestIntoHtml = true,
    prependManifestToJavaScript = false,
    prependManifestToAllJavaScriptChunks = true,
    ...sfxAtlasOptions
  } = options;

  let resolvedConfig = null;
  let sfxAtlasBuildPromise = null;
  let assetsEmitted = false;

  const ensureSfxAtlas = async () => {
    if (!sfxAtlasBuildPromise) {
      if (!resolvedConfig) {
        throw new Error('SFX atlas plugin has not received the resolved Vite config yet.');
      }

      sfxAtlasBuildPromise = packSfxAtlasForBuild({
        projectRoot: resolvedConfig.root,
        publicBase: resolvedConfig.base,
        ...sfxAtlasOptions,
      });
    }

    return sfxAtlasBuildPromise;
  };

  return {
    name: 'vite-plugin-theseus-sfx-atlas',
    apply: 'build',

    configResolved(config) {
      resolvedConfig = config;
    },

    async buildStart() {
      const sfxAtlasBuild = await ensureSfxAtlas();
      if (!sfxAtlasBuild || assetsEmitted) {
        return;
      }

      for (const atlasAsset of sfxAtlasBuild.atlasAssets) {
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
              ?? joinPublicPath(sfxAtlasOptions.outputDir ?? DEFAULT_OUTPUT_DIR, 'sfx-atlas-manifest.json'),
          ),
          source: JSON.stringify(sfxAtlasBuild.manifest, null, 2),
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

      const sfxAtlasBuild = await ensureSfxAtlas();
      if (!sfxAtlasBuild) {
        return null;
      }

      return {
        code: `${buildSfxAtlasManifestAssignment(sfxAtlasBuild.manifest)}\n${code}`,
        map: null,
      };
    },

    async transformIndexHtml(html) {
      if (!injectManifestIntoHtml) {
        return html;
      }

      const sfxAtlasBuild = await ensureSfxAtlas();
      if (!sfxAtlasBuild) {
        return html;
      }

      return {
        html,
        tags: [
          {
            tag: 'script',
            injectTo: 'head-prepend',
            children: buildSfxAtlasManifestAssignment(sfxAtlasBuild.manifest),
          },
        ],
      };
    },
  };
};

const __private__ = {
  FFMPEG_MISSING_MESSAGE,
  buildRuntimeManifest,
  buildSfxAtlasManifestAssignment,
  collectSfxSourceFiles,
  createSfxAliasEntries,
  escapeInlineScriptJson,
  groupSfxSources,
  joinPublicBase,
  joinPublicPath,
  normalizePublicPath,
  roundSeconds,
};

export { createSfxAtlasPlugin, packSfxAtlasForBuild, __private__ };
