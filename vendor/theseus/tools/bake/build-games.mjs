import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

import { createBakeConfig } from './vite.config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, '../..');
const publicRoot = path.join(projectRoot, 'public');
const defaultGamesRoot = path.join(publicRoot, 'games');
const defaultDistRoot = path.join(publicRoot, 'dist');

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const extractTitle = (html) => {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
};

const discoverGames = async ({ gamesRoot = defaultGamesRoot } = {}) => {
  const directoryEntries = await fs.readdir(gamesRoot, { withFileTypes: true });
  const games = [];

  for (const directoryEntry of directoryEntries) {
    if (!directoryEntry.isDirectory() || directoryEntry.name.startsWith('.')) {
      continue;
    }

    const indexPath = path.join(gamesRoot, directoryEntry.name, 'index.html');

    try {
      const html = await fs.readFile(indexPath, 'utf8');
      const gameUrlSegment = encodeURIComponent(directoryEntry.name);
      games.push({
        name: directoryEntry.name,
        title: extractTitle(html) || directoryEntry.name,
        sourcePath: `/games/${gameUrlSegment}/index.html`,
        bakedPath: `/dist/${gameUrlSegment}/index.html`,
        debugPath: `/games/${gameUrlSegment}/index.html?debug`
      });
    }
    catch (error) {
      if (error?.code === 'ENOENT') {
        continue;
      }

      throw error;
    }
  }

  games.sort((left, right) => left.name.localeCompare(right.name));
  return games;
};

const renderGamesIndexHtml = (games) => {
  const gameList = games.length
    ? games.map((game) => `			<li class="game-list-item">
				<span class="game-name">${escapeHtml(game.title)}</span>
				<span class="game-links">
					<a class="button-link" href="${escapeHtml(game.bakedPath)}">Baked</a>
					<a class="button-link" href="${escapeHtml(game.sourcePath)}">Source</a>
					<a class="button-link" href="${escapeHtml(game.debugPath ?? `${game.sourcePath}?debug`)}">Debug</a>
				</span>
			</li>`).join('\n')
    : '			<li class="game-list-item">No game folders found.</li>';

  return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Theseus Games</title>
	<link rel="stylesheet" href="/style.css">
</head>
<body>
	<header class="site-header">
		<a class="brand" href="/">Theseus</a>
		<nav>
			<a href="/games.html">Games</a>
			<a href="/docs.html">Docs</a>
			<a href="/tools/font-tool.html">Font Tool</a>
			<a href="/tools/weltmeister.html">Level Editor</a>
		</nav>
	</header>
	<main class="content">
		<h1>Theseus Games</h1>
		<p>Open a baked game, its source-served version, or the debug build.</p>
		<ul class="game-list">
${gameList}
		</ul>
	</main>
</body>
</html>
`;
};

const buildGames = async ({
  gamesRoot = defaultGamesRoot,
  distRoot = defaultDistRoot
} = {}) => {
  const games = await discoverGames({ gamesRoot });

  if (!games.length) {
    throw new Error(`No games with index.html found in ${gamesRoot}.`);
  }

  await fs.rm(distRoot, { recursive: true, force: true });
  await fs.mkdir(distRoot, { recursive: true });

  for (const game of games) {
    console.log(`Baking ${game.name}...`);
    await build(createBakeConfig({ gameName: game.name, emptyOutDir: true }));
  }

  await fs.writeFile(path.join(distRoot, 'index.html'), renderGamesIndexHtml(games), 'utf8');
  console.log(`Wrote ${path.join(distRoot, 'index.html')}`);

  return games;
};

if (process.argv[1] === __filename) {
  buildGames().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { buildGames, discoverGames, renderGamesIndexHtml };
