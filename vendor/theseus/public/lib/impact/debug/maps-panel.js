import ig from '../ig.js';
import '../background-map.js';
import '../game.js';
import './menu.js';

ig.Game.inject({
  loadLevel: function(data) {
    this.parent(data);

    if (ig.debug?.panels?.maps) {
      ig.debug.panels.maps.load(this);
    }
  },
});

ig.DebugMapsPanel = ig.DebugPanel.extend({
  maps: [],
  mapScreens: [],

  init: function(name, label) {
    this.parent(name, label);
    this.load(ig.game);
  },

  load: function(game) {
    this.options = [];
    this.panels = [];
    this.maps = [];
    this.mapScreens = [];
    this.container.innerHTML = '';

    if (!game || !game.backgroundMaps || !game.backgroundMaps.length) {
      this.container.textContent = 'No background maps loaded';
      return;
    }

    this.maps = game.backgroundMaps;

    for (let m = 0; m < this.maps.length; m++) {
      const map = this.maps[m];
      const subPanel = new ig.DebugPanel(`map-${m}`, `Layer ${m}`);
      const head = ig.$new('strong');
      head.textContent = `${m}: ${map.name || map.tilesetName || map.tiles?.path || 'map'}`;
      subPanel.container.appendChild(head);
      subPanel.addOption(new ig.DebugOption('Enabled', map, 'enabled'));
      subPanel.addOption(new ig.DebugOption('Pre Rendered', map, 'preRender'));
      subPanel.addOption(new ig.DebugOption('Show Chunks', map, 'debugChunks'));
      this.generateMiniMap(subPanel, map, m);
      this.addPanel(subPanel);
    }
  },

  generateMiniMap: function(panel, map, id) {
    if (!map.tiles?.loaded || !map.width || !map.height) {
      return;
    }

    const scale = Math.max(1, ig.system.scale || 1);
    const tileset = ig.$new('canvas');
    const tilesetCtx = tileset.getContext('2d');
    const source = map.tiles.getSourceRect
      ? map.tiles.getSourceRect(0, 0, map.tiles.width, map.tiles.height)
      : { x: 0, y: 0, width: map.tiles.width * scale, height: map.tiles.height * scale };

    const scaledTilesetWidth = map.tiles.width * scale;
    const scaledTilesetHeight = map.tiles.height * scale;
    const tileColumns = scaledTilesetWidth / map.tilesize;
    const tileRows = scaledTilesetHeight / map.tilesize;

    tileset.width = tileColumns;
    tileset.height = tileRows;
    tilesetCtx.drawImage(
      map.tiles.data,
      source.x,
      source.y,
      source.width,
      source.height,
      0,
      0,
      tileColumns,
      tileRows,
    );

    const mapCanvas = ig.$new('canvas');
    mapCanvas.width = map.width * scale;
    mapCanvas.height = map.height * scale;

    const ctx = mapCanvas.getContext('2d');
    if (ig.game.clearColor) {
      ctx.fillStyle = ig.game.clearColor;
      ctx.fillRect(0, 0, mapCanvas.width, mapCanvas.height);
    }

    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const tile = map.data[y][x];
        if (!tile) {
          continue;
        }

        ctx.drawImage(
          tileset,
          Math.floor(((tile - 1) * scale) % tileColumns),
          Math.floor(((tile - 1) * scale) / tileColumns) * scale,
          scale,
          scale,
          x * scale,
          y * scale,
          scale,
          scale,
        );
      }
    }

    const mapContainer = ig.$new('div');
    mapContainer.className = 'ig_debug_map_container';
    mapContainer.style.width = `${map.width * scale}px`;
    mapContainer.style.height = `${map.height * scale}px`;

    const mapScreen = ig.$new('div');
    mapScreen.className = 'ig_debug_map_screen';
    mapScreen.style.width = `${(ig.system.width / map.tilesize) * scale - 2}px`;
    mapScreen.style.height = `${(ig.system.height / map.tilesize) * scale - 2}px`;
    this.mapScreens[id] = mapScreen;

    mapContainer.appendChild(mapCanvas);
    mapContainer.appendChild(mapScreen);
    panel.container.appendChild(mapContainer);
  },

  afterRun: function() {
    const scale = Math.max(1, ig.system.scale || 1);

    for (let m = 0; m < this.maps.length; m++) {
      const map = this.maps[m];
      const screen = this.mapScreens[m];

      if (!map || !screen) {
        continue;
      }

      let x = map.scroll.x / map.tilesize;
      let y = map.scroll.y / map.tilesize;

      if (map.repeat) {
        x %= map.width;
        y %= map.height;
      }

      screen.style.left = `${x * scale}px`;
      screen.style.top = `${y * scale}px`;
    }
  },
});

ig.debug.addPanel({
  type: ig.DebugMapsPanel,
  name: 'maps',
  label: 'Background Maps',
});
