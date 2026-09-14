import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import sharp from 'sharp';

const require = createRequire(import.meta.url);
const texturePacker = require('free-tex-packer-core');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const DEFAULT_OUTPUT_DIR = 'assets';

const toPosixPath = (value) => value.split(path.sep).join('/').replace(/\\/g, '/');

const normalizePublicPath = (value) =>
  toPosixPath(String(value || '')).replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');

const joinPublicPath = (...parts) =>
  parts.map((part) => normalizePublicPath(part)).filter(Boolean).join('/');

const joinPublicBase = (base, fileName) => {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  return `${normalizedBase}${normalizePublicPath(fileName)}`;
};

const nextPowerOfTwo = (value) => {
  if (value <= 1) {
    return 1;
  }

  return 2 ** Math.ceil(Math.log2(value));
};

const escapeInlineScriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

const buildTextureAtlasManifestAssignment = (manifest) =>
  `globalThis.__THESEUS_TEXTURE_ATLAS_MANIFEST__ = ${escapeInlineScriptJson(manifest)};`;

const collectTextureInputs = async (absoluteDirectory, projectRoot) => {
  const directoryEntries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  directoryEntries.sort((left, right) => left.name.localeCompare(right.name));

  const results = [];

  for (const directoryEntry of directoryEntries) {
    const absolutePath = path.join(absoluteDirectory, directoryEntry.name);

    if (directoryEntry.isDirectory()) {
      const nestedResults = await collectTextureInputs(absolutePath, projectRoot);
      results.push(...nestedResults);
      continue;
    }

    const extension = path.extname(directoryEntry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) {
      continue;
    }

    results.push({
      path: toPosixPath(path.relative(projectRoot, absolutePath)),
      contents: await fs.readFile(absolutePath),
    });
  }

  return results;
};

const groupPackedFiles = (packedFiles) => {
  const groups = new Map();

  for (const packedFile of packedFiles) {
    const extension = path.extname(packedFile.name).toLowerCase();
    const baseName = packedFile.name.slice(0, -extension.length);
    const existingGroup = groups.get(baseName) || {};

    if (extension === '.json') {
      existingGroup.metadata = packedFile;
    }
    else {
      existingGroup.texture = packedFile;
      existingGroup.textureExtension = extension;
    }

    groups.set(baseName, existingGroup);
  }

  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
};

const buildRuntimeManifest = ({ groupedPackedFiles, publicBase, outputDir }) => {
  const manifest = {
    version: 1,
    atlases: [],
    images: {},
  };

  const atlasAssets = [];

  for (const [baseName, group] of groupedPackedFiles) {
    if (!group.metadata || !group.texture) {
      throw new Error(`Incomplete packed texture output for atlas "${baseName}".`);
    }

    const atlasMetadata = JSON.parse(group.metadata.buffer.toString('utf8'));
    const atlasIndex = manifest.atlases.length;
    const atlasFileName = joinPublicPath(outputDir, `${path.posix.basename(baseName)}.webp`);

    atlasAssets.push({
      fileName: atlasFileName,
      source: group.texture.buffer,
    });

    manifest.atlases.push({
      image: joinPublicBase(publicBase, atlasFileName),
      width: atlasMetadata.meta?.size?.w ?? 0,
      height: atlasMetadata.meta?.size?.h ?? 0,
    });

    for (const [imagePath, frameData] of Object.entries(atlasMetadata.frames || {})) {
      if (frameData.rotated || frameData.trimmed) {
        throw new Error(
          `Packed texture "${imagePath}" uses rotation or trimming, but Theseus currently relies on whole-image atlas frames.`,
        );
      }

      manifest.images[toPosixPath(imagePath)] = {
        atlas: atlasIndex,
        frame: {
          x: frameData.frame.x,
          y: frameData.frame.y,
          w: frameData.frame.w,
          h: frameData.frame.h,
        },
        sourceSize: {
          w: frameData.sourceSize.w,
          h: frameData.sourceSize.h,
        },
      };
    }
  }

  return { atlasAssets, manifest };
};

const convertAtlasAssetsToWebp = async (atlasAssets, webpOptions) => Promise.all(
  atlasAssets.map(async (atlasAsset) => ({
    ...atlasAsset,
    source: await sharp(atlasAsset.source).webp(webpOptions).toBuffer(),
  })),
);

const packTexturesForBuild = async ({
  projectRoot,
  publicBase,
  sourceDir = 'games/example/media',
  outputDir = DEFAULT_OUTPUT_DIR,
  atlasName = 'theseus-atlas',
  atlasWidth = 2048,
  atlasHeight = 2048,
  padding = 0,
  extrude = 0,
  powerOfTwo = true,
  webpOptions = { lossless: true },
} = {}) => {
  const absoluteSourceDirectory = path.join(projectRoot, sourceDir);

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

  const textureInputs = await collectTextureInputs(absoluteSourceDirectory, projectRoot);
  if (!textureInputs.length) {
    return null;
  }

  const imageMetadata = await Promise.all(
    textureInputs.map(async (textureInput) => sharp(textureInput.contents).metadata()),
  );
  const maxSourceWidth = Math.max(...imageMetadata.map((metadata) => metadata.width || 0));
  const maxSourceHeight = Math.max(...imageMetadata.map((metadata) => metadata.height || 0));
  const effectiveAtlasWidth = powerOfTwo
    ? Math.max(atlasWidth, nextPowerOfTwo(maxSourceWidth))
    : Math.max(atlasWidth, maxSourceWidth);
  const effectiveAtlasHeight = powerOfTwo
    ? Math.max(atlasHeight, nextPowerOfTwo(maxSourceHeight))
    : Math.max(atlasHeight, maxSourceHeight);

  const packedFiles = await texturePacker.packAsync(textureInputs, {
    // Theseus still addresses images by their original internal coordinates.
    // Packing whole source images keeps ig.Image.draw() and drawTile() compatible
    // without having to remap trimmed or rotated sprite rectangles.
    textureName: atlasName,
    width: effectiveAtlasWidth,
    height: effectiveAtlasHeight,
    powerOfTwo,
    fixedSize: false,
    padding,
    extrude,
    allowRotation: false,
    allowTrim: false,
    detectIdentical: true,
    removeFileExtension: false,
    prependFolderName: true,
    textureFormat: 'png',
    exporter: 'JsonHash',
    filter: 'none',
  });

  const groupedPackedFiles = groupPackedFiles(packedFiles);
  const { atlasAssets, manifest } = buildRuntimeManifest({ groupedPackedFiles, publicBase, outputDir });
  const webpAtlasAssets = await convertAtlasAssetsToWebp(atlasAssets, webpOptions);

  return {
    atlasAssets: webpAtlasAssets,
    manifest,
  };
};

const createTextureAtlasPlugin = (options = {}) => {
  const {
    emitManifestFile = false,
    injectManifestIntoHtml = true,
    prependManifestToJavaScript = false,
    prependManifestToAllJavaScriptChunks = true,
    ...textureOptions
  } = options;

  let resolvedConfig = null;
  let textureAtlasBuildPromise = null;
  let assetsEmitted = false;

  const ensureTextureAtlases = async () => {
    if (!textureAtlasBuildPromise) {
      if (!resolvedConfig) {
        throw new Error('Texture atlas plugin has not received the resolved Vite config yet.');
      }

      textureAtlasBuildPromise = packTexturesForBuild({
        projectRoot: resolvedConfig.root,
        publicBase: resolvedConfig.base,
        ...textureOptions,
      });
    }

    return textureAtlasBuildPromise;
  };

  return {
    name: 'vite-plugin-theseus-texture-atlas',
    apply: 'build',

    configResolved(config) {
      resolvedConfig = config;
    },

    async buildStart() {
      const textureAtlasBuild = await ensureTextureAtlases();
      if (!textureAtlasBuild || assetsEmitted) {
        return;
      }

      for (const atlasAsset of textureAtlasBuild.atlasAssets) {
        this.emitFile({
          type: 'asset',
          fileName: atlasAsset.fileName,
          source: atlasAsset.source,
        });
      }

      if (emitManifestFile) {
        this.emitFile({
          type: 'asset',
          fileName: joinPublicPath(
            textureOptions.outputDir ?? DEFAULT_OUTPUT_DIR,
            'texture-atlas-manifest.json',
          ),
          source: JSON.stringify(textureAtlasBuild.manifest, null, 2),
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

      const textureAtlasBuild = await ensureTextureAtlases();
      if (!textureAtlasBuild) {
        return null;
      }

      return {
        code: `${buildTextureAtlasManifestAssignment(textureAtlasBuild.manifest)}\n${code}`,
        map: null,
      };
    },

    async transformIndexHtml(html) {
      if (!injectManifestIntoHtml) {
        return html;
      }

      const textureAtlasBuild = await ensureTextureAtlases();
      if (!textureAtlasBuild) {
        return html;
      }

      return {
        html,
        tags: [
          {
            tag: 'script',
            injectTo: 'head-prepend',
            children: buildTextureAtlasManifestAssignment(textureAtlasBuild.manifest),
          },
        ],
      };
    },
  };
};

export { createTextureAtlasPlugin, packTexturesForBuild };
