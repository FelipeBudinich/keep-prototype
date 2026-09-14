import ig from '../ig.js';
import '../system.js';
import '../image.js';

const globalScope = typeof window !== 'undefined' ? window : globalThis;
const documentRef = globalScope.document;

const installStylesheet = () => {
  if (!documentRef || documentRef.getElementById('theseus-debug-styles')) {
    return;
  }

  const link = ig.$new('link');
  link.id = 'theseus-debug-styles';
  link.rel = 'stylesheet';
  link.type = 'text/css';
  link.href = new URL('./debug.css', import.meta.url).href;
  documentRef.head.appendChild(link);
};

const createText = (text) => documentRef.createTextNode(text);

if (!ig.Debug) {
  ig.System.inject({
    run: function() {
      if (ig.debug) {
        ig.debug.beforeRun();
      }

      this.parent();

      if (ig.debug) {
        ig.debug.afterRun();
      }
    },

    setGameNow: function(gameClass) {
      this.parent(gameClass);

      if (ig.debug) {
        ig.debug.ready();
      }
    },
  });

  ig.Debug = ig.Class.extend({
    panels: {},
    numbers: {},
    container: null,
    panelMenu: null,
    numberContainer: null,
    activePanel: null,
    debugTime: 0,
    debugTickAvg: 1000 / 60,
    debugRealTime: Date.now(),

    init: function() {
      if (!documentRef) {
        return;
      }

      installStylesheet();

      this.container = ig.$new('div');
      this.container.className = 'ig_debug';
      documentRef.body.appendChild(this.container);

      this.panelMenu = ig.$new('div');
      this.panelMenu.className = 'ig_debug_panel_menu';
      this.container.appendChild(this.panelMenu);

      const title = ig.$new('div');
      title.className = 'ig_debug_head';
      title.textContent = 'Theseus.Debug:';
      this.panelMenu.appendChild(title);

      this.numberContainer = ig.$new('div');
      this.numberContainer.className = 'ig_debug_stats';
      this.panelMenu.appendChild(this.numberContainer);

      if (globalScope.console?.log) {
        ig.log = globalScope.console.log.bind
          ? globalScope.console.log.bind(globalScope.console)
          : globalScope.console.log;
      }

      if (globalScope.console?.assert) {
        ig.assert = globalScope.console.assert.bind
          ? globalScope.console.assert.bind(globalScope.console)
          : globalScope.console.assert;
      }

      ig.show = this.showNumber.bind(this);
    },

    addNumber: function(name) {
      if (!this.numberContainer) {
        return;
      }

      const number = ig.$new('span');
      this.numberContainer.appendChild(number);
      this.numberContainer.appendChild(createText(name));
      this.numbers[name] = number;
    },

    showNumber: function(name, number) {
      if (!this.numbers[name]) {
        this.addNumber(name);
      }

      if (this.numbers[name]) {
        this.numbers[name].textContent = number;
      }
    },

    addPanel: function(panelDef) {
      if (!this.container || !this.panelMenu) {
        return;
      }

      const panel = new panelDef.type(panelDef.name, panelDef.label);

      if (panelDef.options) {
        for (let i = 0; i < panelDef.options.length; i++) {
          const opt = panelDef.options[i];
          panel.addOption(new ig.DebugOption(opt.name, opt.object, opt.property));
        }
      }

      this.panels[panel.name] = panel;
      panel.container.style.display = 'none';
      this.container.appendChild(panel.container);

      const menuItem = ig.$new('button');
      menuItem.className = 'ig_debug_menu_item';
      menuItem.type = 'button';
      menuItem.textContent = panel.label;
      menuItem.addEventListener('click', () => this.togglePanel(panel), false);
      panel.menuItem = menuItem;

      let inserted = false;
      for (let i = 1; i < this.panelMenu.childNodes.length; i++) {
        const child = this.panelMenu.childNodes[i];
        if (child.className === 'ig_debug_stats') {
          continue;
        }

        if (child.textContent > panel.label) {
          this.panelMenu.insertBefore(menuItem, child);
          inserted = true;
          break;
        }
      }

      if (!inserted) {
        this.panelMenu.insertBefore(menuItem, this.numberContainer);
      }
    },

    showPanel: function(name) {
      if (this.panels[name]) {
        this.togglePanel(this.panels[name]);
      }
    },

    togglePanel: function(panel) {
      if (!panel) {
        return;
      }

      if (panel !== this.activePanel && this.activePanel) {
        this.activePanel.toggle(false);
        this.activePanel.menuItem.className = 'ig_debug_menu_item';
        this.activePanel = null;
      }

      const active = panel.container.style.display !== 'block';
      panel.toggle(active);
      panel.menuItem.className = `ig_debug_menu_item${active ? ' active' : ''}`;
      this.activePanel = active ? panel : null;
    },

    ready: function() {
      for (const name in this.panels) {
        this.panels[name].ready();
      }
    },

    beforeRun: function() {
      const now = Date.now();
      this.debugTickAvg = this.debugTickAvg * 0.8 + (now - this.debugRealTime) * 0.2;
      this.debugRealTime = now;

      if (this.activePanel) {
        this.activePanel.beforeRun();
      }
    },

    afterRun: function() {
      const frameTime = Date.now() - this.debugRealTime;
      this.debugTime = this.debugTime * 0.8 + frameTime * 0.2;

      if (this.activePanel) {
        this.activePanel.afterRun();
      }

      this.showNumber('ms', this.debugTime.toFixed(2));
      this.showNumber('fps', Math.round(1000 / Math.max(this.debugTickAvg, 1)));
      this.showNumber('draws', ig.Image?.drawCount ?? 0);

      if (ig.game?.entities) {
        this.showNumber('entities', ig.game.entities.length);
      }

      if (ig.Image) {
        ig.Image.drawCount = 0;
      }
    },
  });

  ig.DebugPanel = ig.Class.extend({
    active: false,
    container: null,
    options: [],
    panels: [],
    label: '',
    name: '',

    init: function(name, label) {
      this.name = String(name);
      this.label = label;
      this.container = ig.$new('div');
      this.container.className = `ig_debug_panel ${this.name}`;
    },

    toggle: function(active) {
      this.active = active;
      this.container.style.display = active ? 'block' : 'none';
    },

    addPanel: function(panel) {
      this.panels.push(panel);
      this.container.appendChild(panel.container);
    },

    addOption: function(option) {
      this.options.push(option);
      this.container.appendChild(option.container);
    },

    ready: function() {},
    beforeRun: function() {},
    afterRun: function() {},
  });

  ig.DebugOption = ig.Class.extend({
    name: '',
    object: null,
    property: '',
    label: null,
    mark: null,
    container: null,
    active: false,

    init: function(name, object, property) {
      this.name = name;
      this.object = object;
      this.property = property;
      this.active = !!this.object[this.property];

      this.container = ig.$new('button');
      this.container.className = 'ig_debug_option';
      this.container.type = 'button';

      this.mark = ig.$new('span');
      this.mark.className = 'ig_debug_label_mark';

      this.label = ig.$new('span');
      this.label.className = 'ig_debug_label';
      this.label.textContent = this.name;

      this.container.appendChild(this.mark);
      this.container.appendChild(this.label);
      this.container.addEventListener('click', this.click.bind(this), false);
      this.setLabel();
    },

    setLabel: function() {
      this.mark.className = `ig_debug_label_mark${this.active ? ' enabled' : ''}`;
    },

    click: function(event) {
      this.active = !this.active;
      this.object[this.property] = this.active;
      this.setLabel();
      event.stopPropagation();
      event.preventDefault();
      return false;
    },
  });

  ig.debug = new ig.Debug();
}

export default ig.debug;
