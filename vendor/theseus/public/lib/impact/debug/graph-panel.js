import ig from '../ig.js';
import '../game.js';
import '../system.js';
import './menu.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

ig.Game.inject({
  draw: function() {
    ig.graph.beginClock('draw');
    this.parent();
    ig.graph.endClock('draw');
  },

  update: function() {
    ig.graph.beginClock('update');
    this.parent();
    ig.graph.endClock('update');
  },

  checkEntities: function() {
    ig.graph.beginClock('checks');
    this.parent();
    ig.graph.endClock('checks');
  },
});

ig.DebugGraphPanel = ig.DebugPanel.extend({
  clocks: {},
  marks: [],
  textY: 0,
  height: 128,
  ms: 64,
  timeBeforeRun: 0,
  graph: null,
  ctx: null,

  init: function(name, label) {
    this.parent(name, label);

    this.mark16ms = Math.round(this.height - (this.height / this.ms) * 16);
    this.mark33ms = Math.round(this.height - (this.height / this.ms) * 33);
    this.msHeight = this.height / this.ms;

    this.graph = ig.$new('canvas');
    this.graph.width = window.innerWidth;
    this.graph.height = this.height;
    this.container.appendChild(this.graph);

    this.ctx = this.graph.getContext('2d');
    this.ctx.fillStyle = '#444';
    this.ctx.fillRect(0, this.mark16ms, this.graph.width, 1);
    this.ctx.fillRect(0, this.mark33ms, this.graph.width, 1);

    this.addGraphMark('16ms', this.mark16ms);
    this.addGraphMark('33ms', this.mark33ms);
    this.addClock('draw', 'Draw', '#13baff');
    this.addClock('update', 'Entity Update', '#bb0fff');
    this.addClock('checks', 'Entity Checks & Collisions', '#a2e908');
    this.addClock('lag', 'System Lag', '#f26900');

    ig.mark = this.mark.bind(this);
    ig.graph = this;
  },

  addGraphMark: function(name, height) {
    const span = ig.$new('span');
    span.className = 'ig_debug_graph_mark';
    span.textContent = name;
    span.style.top = `${Math.round(height)}px`;
    this.container.appendChild(span);
  },

  addClock: function(name, description, color) {
    const mark = ig.$new('span');
    mark.className = 'ig_debug_legend_color';
    mark.style.backgroundColor = color;

    const number = ig.$new('span');
    number.className = 'ig_debug_legend_number';
    number.textContent = '0';

    const legend = ig.$new('span');
    legend.className = 'ig_debug_legend';
    legend.appendChild(mark);
    legend.appendChild(document.createTextNode(`${description} (`));
    legend.appendChild(number);
    legend.appendChild(document.createTextNode('ms)'));
    this.container.appendChild(legend);

    this.clocks[name] = {
      color,
      current: 0,
      start: now(),
      avg: 0,
      html: number,
    };
  },

  beginClock: function(name, offset = 0) {
    if (this.clocks[name]) {
      this.clocks[name].start = now() + offset;
    }
  },

  endClock: function(name) {
    const clock = this.clocks[name];
    if (!clock) {
      return;
    }

    clock.current = Math.max(0, now() - clock.start);
    clock.avg = clock.avg * 0.8 + clock.current * 0.2;
  },

  mark: function(message, color = '#fff') {
    if (this.active) {
      this.marks.push({ message, color });
    }
  },

  beforeRun: function() {
    this.endClock('lag');
    this.timeBeforeRun = now();
  },

  afterRun: function() {
    const frameTime = now() - this.timeBeforeRun;
    const nextFrameDue = 1000 / ig.system.fps - frameTime;
    this.beginClock('lag', Math.max(nextFrameDue, 0));

    const x = this.graph.width - 1;
    let y = this.height;

    this.ctx.drawImage(this.graph, -1, 0);
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(x, 0, 1, this.height);
    this.ctx.fillStyle = '#444';
    this.ctx.fillRect(x, this.mark16ms, 1, 1);
    this.ctx.fillRect(x, this.mark33ms, 1, 1);

    for (const name in this.clocks) {
      const clock = this.clocks[name];
      clock.html.textContent = clock.avg.toFixed(2);

      if (clock.color && clock.current > 0) {
        const h = clock.current * this.msHeight;
        y -= h;
        this.ctx.fillStyle = clock.color;
        this.ctx.fillRect(x, y, 1, h);
        clock.current = 0;
      }
    }

    this.ctx.textAlign = 'right';
    this.ctx.textBaseline = 'top';
    this.ctx.globalAlpha = 0.5;

    for (let i = 0; i < this.marks.length; i++) {
      const mark = this.marks[i];
      this.ctx.fillStyle = mark.color;
      this.ctx.fillRect(x, 0, 1, this.height);

      if (mark.message) {
        this.ctx.fillText(mark.message, x - 1, this.textY);
        this.textY = (this.textY + 8) % 32;
      }
    }

    this.ctx.globalAlpha = 1;
    this.marks = [];
  },
});

ig.debug.addPanel({
  type: ig.DebugGraphPanel,
  name: 'graph',
  label: 'Performance',
});
