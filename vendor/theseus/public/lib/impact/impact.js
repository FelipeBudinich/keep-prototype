import ig from './ig.js';
import './animation.js';
import './background-map.js';
import './collision-map.js';
import './entity.js';
import './entity-pool.js';
import './font.js';
import './game.js';
import './image.js';
import './input.js';
import './loader.js';
import './map.js';
import './sound.js';
import './system.js';
import './timer.js';

await ig.debugReady;

ig.boot();

ig.main = function main(canvasId, gameClass, fps, width, height, scale, loaderClass) {
  ig.boot();
  ig.system = new ig.System(canvasId, fps, width, height, scale || 1);
  ig.input = new ig.Input();
  ig.soundManager = new ig.SoundManager();
  ig.music = new ig.Music();
  ig.ready = true;

  const loader = new (loaderClass || ig.Loader)(gameClass, ig.resources);
  loader.load();
};

export default ig;
