import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

import { createMusicAtlasPlugin } from './music-atlas-plugin.mjs';
import { createSfxAtlasPlugin } from './sfx-atlas-plugin.mjs';
import { createTextureAtlasPlugin } from './texture-atlas-plugin.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, '../..');
const publicRoot = path.join(projectRoot, 'public');

const assertSafeGameName = (gameName) => {
  if (!gameName || gameName.startsWith('.') || gameName.includes('/') || gameName.includes('\\')) {
    throw new Error(`Invalid game name "${gameName}".`);
  }
};

const createGameIndexOutputPlugin = ({ gameName, outDir }) => ({
  name: 'theseus-game-index-output',
  async closeBundle() {
    const nestedIndex = path.join(outDir, 'games', gameName, 'index.html');
    const gameIndex = path.join(outDir, 'index.html');

    await fs.rename(nestedIndex, gameIndex);
    await fs.rm(path.join(outDir, 'games'), { recursive: true, force: true });
  }
});

const createBakeConfig = ({ gameName = 'example', emptyOutDir = true } = {}) => {
  assertSafeGameName(gameName);

  const gameIndex = `games/${gameName}/index.html`;
  const gameMediaRoot = `games/${gameName}/media`;
  const outDir = path.join(publicRoot, 'dist', gameName);
  const gameUrlSegment = encodeURIComponent(gameName);

  return defineConfig({
    configFile: false,
    root: publicRoot,
    base: `/dist/${gameUrlSegment}/`,
    publicDir: false,

    define: {
      'globalThis.__THESEUS_INCLUDE_DEBUG__': false
    },

    plugins: [
      createTextureAtlasPlugin({
        sourceDir: gameMediaRoot,
        outputDir: 'assets',
        injectManifestIntoHtml: false,
        prependManifestToJavaScript: true,
      }),
      createSfxAtlasPlugin({
        sourceDir: `${gameMediaRoot}/sounds`,
        atlasName: 'sfx-atlas',
        outputDir: 'assets',
        injectManifestIntoHtml: false,
        prependManifestToJavaScript: true
      }),
      createMusicAtlasPlugin({
        sourceDir: `${gameMediaRoot}/music`,
        atlasName: 'music-atlas',
        outputDir: 'assets',
        injectManifestIntoHtml: false,
        prependManifestToJavaScript: true
      }),
      createGameIndexOutputPlugin({ gameName, outDir })
    ],

    build: {
      outDir,
      emptyOutDir,
      rollupOptions: {
        input: path.join(publicRoot, gameIndex)
      }
    }
  });
};

export default defineConfig(() =>
  createBakeConfig({ gameName: process.env.THESEUS_BAKE_GAME || 'example' })
);

export { createBakeConfig };
