const hasOwn = Object.prototype.hasOwnProperty;

const definePrototypeMethod = (prototype, name, value) => {
  if (!hasOwn.call(prototype, name)) {
    Object.defineProperty(prototype, name, {
      value,
      configurable: true,
      writable: true
    });
  }
};

const installNativeExtensions = () => {
  definePrototypeMethod(Number.prototype, 'map', function map(
    istart,
    istop,
    ostart,
    ostop
  ) {
    return ostart + (ostop - ostart) * ((this - istart) / (istop - istart));
  });

  definePrototypeMethod(Number.prototype, 'limit', function limit(min, max) {
    return Math.min(max, Math.max(min, this));
  });

  definePrototypeMethod(Number.prototype, 'round', function round(precision) {
    const multiplier = Math.pow(10, precision || 0);
    return Math.round(this * multiplier) / multiplier;
  });

  definePrototypeMethod(Number.prototype, 'floor', function floor() {
    return Math.floor(this);
  });

  definePrototypeMethod(Number.prototype, 'ceil', function ceil() {
    return Math.ceil(this);
  });

  definePrototypeMethod(Number.prototype, 'toInt', function toInt() {
    return this | 0;
  });

  definePrototypeMethod(Number.prototype, 'toRad', function toRad() {
    return (this / 180) * Math.PI;
  });

  definePrototypeMethod(Number.prototype, 'toDeg', function toDeg() {
    return (this * 180) / Math.PI;
  });

  definePrototypeMethod(Array.prototype, 'erase', function erase(item) {
    for (let index = this.length; index--;) {
      if (this[index] === item) {
        this.splice(index, 1);
      }
    }

    return this;
  });

  definePrototypeMethod(Array.prototype, 'random', function random() {
    return this[Math.floor(Math.random() * this.length)];
  });
};

const createNamespace = (target, namespacePath) => {
  if (!namespacePath) {
    return target;
  }

  return namespacePath.split('.').reduce((current, segment) => {
    if (!segment) {
      return current;
    }

    if (typeof current[segment] !== 'object' || current[segment] === null) {
      current[segment] = {};
    }

    return current[segment];
  }, target);
};

const isDomElement = (value) =>
  typeof HTMLElement !== 'undefined' && value instanceof HTMLElement;

const isImpactClassInstance = (ig, value) =>
  Boolean(ig.Class) && value instanceof ig.Class;

const copy = (ig, object) => {
  if (
    !object ||
    typeof object !== 'object' ||
    isDomElement(object) ||
    isImpactClassInstance(ig, object)
  ) {
    return object;
  }

  if (Array.isArray(object)) {
    return object.map((value) => copy(ig, value));
  }

  const clone = {};

  for (const key in object) {
    clone[key] = copy(ig, object[key]);
  }

  return clone;
};

const merge = (ig, original, extended) => {
  for (const key in extended) {
    const value = extended[key];

    if (
      typeof value !== 'object' ||
      value === null ||
      isDomElement(value) ||
      isImpactClassInstance(ig, value)
    ) {
      original[key] = value;
      continue;
    }

    if (!original[key] || typeof original[key] !== 'object') {
      original[key] = Array.isArray(value) ? [] : {};
    }

    merge(ig, original[key], value);
  }

  return original;
};

const ksort = (object) => {
  if (!object || typeof object !== 'object') {
    return [];
  }

  return Object.keys(object)
    .sort()
    .map((key) => object[key]);
};

const fnTest = /xyz/.test(() => {
  xyz;
})
  ? /\bparent\b/
  : /.*/;

let lastClassId = 0;

const shouldWrapParentMethod = (value, parentValue) =>
  typeof value === 'function' &&
  typeof parentValue === 'function' &&
  fnTest.test(value);

const wrapParentMethod = (parentMethod, method) =>
  function parentWrappedMethod(...args) {
    const previousParent = this.parent;
    this.parent = parentMethod;

    try {
      return method.apply(this, args);
    } finally {
      this.parent = previousParent;
    }
  };

const applyClassProperties = (target, parent, properties) => {
  for (const name in properties) {
    const value = properties[name];

    target[name] = shouldWrapParentMethod(value, parent[name])
      ? wrapParentMethod(parent[name], value)
      : value;
  }
};

const installClassSystem = (ig) => {
  if (ig.Class && typeof ig.Class.extend === 'function') {
    return ig.Class;
  }

  let initializing = false;

  const inject = function inject(properties = {}) {
    applyClassProperties(this.prototype, this.prototype, properties);
  };

  const ImpactClass = function ImpactClass() {};

  ImpactClass.extend = function extend(properties = {}) {
    const parent = this.prototype;

    initializing = true;
    const prototype = new this();
    initializing = false;

    applyClassProperties(prototype, parent, properties);

    function Class(...args) {
      if (!initializing) {
        if (this.staticInstantiate) {
          const instance = this.staticInstantiate(...args);

          if (instance) {
            return instance;
          }
        }

        for (const property in this) {
          if (typeof this[property] === 'object') {
            this[property] = ig.copy(this[property]);
          }
        }

        if (this.init) {
          this.init(...args);
        }
      }

      return this;
    }

    Class.prototype = prototype;
    Class.prototype.constructor = Class;
    Class.extend = ImpactClass.extend;
    Class.inject = inject;
    Class.classId = prototype.classId = ++lastClassId;

    return Class;
  };

  ig.Class = ImpactClass;
  return ig.Class;
};

installNativeExtensions();

const globalScope = typeof window !== 'undefined' ? window : globalThis;

if (!globalScope.window) {
  globalScope.window = globalScope;
}

const existingIg =
  globalScope.ig && typeof globalScope.ig === 'object' ? globalScope.ig : {};

const ig = existingIg;

const debugValueEnablesDebug = (value) => value === '' || value === 'true';

const hasDebugQuery = () => {
  const search =
    globalScope.location?.search ||
    globalScope.document?.location?.search ||
    '';

  const debugValues = new URLSearchParams(search).getAll('debug');

  return (
    debugValues.length > 0 &&
    debugValues.every((value) => debugValueEnablesDebug(value))
  );
};

const loadDebugFromUrl = () => {
  if (ig.debugReady) {
    return ig.debugReady;
  }

  ig.debugReady =
    globalThis.__THESEUS_INCLUDE_DEBUG__ !== false && hasDebugQuery()
      ? import('./debug/debug.js').then(() => ig.debug ?? null)
      : Promise.resolve(null);

  return ig.debugReady;
};

const configureAnimationHelpers = () => {
  if (ig._animationConfigured) {
    return;
  }

  if (typeof globalScope.requestAnimationFrame === 'function') {
    let nextAnimationId = 1;
    const animations = {};

    ig.setAnimation = (callback) => {
      const currentAnimationId = nextAnimationId++;
      animations[currentAnimationId] = true;

      const animate = () => {
        if (!animations[currentAnimationId]) {
          return;
        }

        globalScope.requestAnimationFrame(animate);
        callback();
      };

      globalScope.requestAnimationFrame(animate);
      return currentAnimationId;
    };

    ig.clearAnimation = (animationId) => {
      delete animations[animationId];
    };
  } else {
    ig.setAnimation = (callback) => globalScope.setInterval(callback, 1000 / 60);
    ig.clearAnimation = (animationId) => globalScope.clearInterval(animationId);
  }

  ig._animationConfigured = true;
};

const bootEnvironment = () => {
  if (ig._booted) {
    return ig;
  }

  const href = globalScope.document?.location?.href || '';

  if (href.match(/\?nocache/)) {
    ig.setNocache(true);
  }

  ig.ua.pixelRatio = globalScope.devicePixelRatio || 1;
  ig.ua.viewport = {
    width: globalScope.innerWidth || 0,
    height: globalScope.innerHeight || 0
  };
  ig.ua.screen = {
    width: (globalScope.screen?.availWidth || 0) * ig.ua.pixelRatio,
    height: (globalScope.screen?.availHeight || 0) * ig.ua.pixelRatio
  };

  const userAgent = globalScope.navigator?.userAgent || '';
  ig.ua.iPhone = /iPhone|iPod/i.test(userAgent);
  ig.ua.iPad = /iPad/i.test(userAgent);
  ig.ua.android = /android/i.test(userAgent);
  ig.ua.iOS = ig.ua.iPhone || ig.ua.iPad;
  ig.ua.mobile = ig.ua.iOS || ig.ua.android || /mobile/i.test(userAgent);

  const maxTouchPoints = Number(globalScope.navigator?.maxTouchPoints || 0);
  const hasTouchEvents = 'ontouchstart' in globalScope;
  const hasPointerTouch =
    typeof globalScope.PointerEvent === 'function' && maxTouchPoints > 0;
  ig.ua.touchDevice = hasTouchEvents || hasPointerTouch;

  configureAnimationHelpers();

  if (globalScope.ImpactMixin) {
    ig.merge(ig, globalScope.ImpactMixin);
  }

  ig._booted = true;
  return ig;
};

ig.game ??= null;
ig.debug ??= null;
ig.version ??= '1.24';
ig.global = globalScope;
ig.classes ??= Object.create(null);
ig.modules ??= {};
ig.resources ??= [];
ig.ready ??= false;
ig.baked ??= false;
ig.nocache ??= '';
ig.ua ??= {};
ig._booted ??= false;
ig._animationConfigured ??= false;
ig.prefix ??= globalScope.ImpactPrefix || '';
ig.lib ??= 'lib/';
ig.$ ??= (selector) => {
  const documentRef = globalScope.document;

  if (!documentRef) {
    return null;
  }

  if (typeof selector !== 'string') {
    return selector;
  }

  return selector.charAt(0) === '#'
    ? documentRef.getElementById(selector.slice(1))
    : documentRef.getElementsByTagName(selector);
};
ig.$new ??= (name) => globalScope.document?.createElement(name) ?? null;
ig.addResource ??= (resource) => {
  ig.resources.push(resource);
};
ig.registerClass ??= (name, klass) => {
  if (!name || !klass) {
    return klass ?? null;
  }

  ig.classes[name] = klass;
  klass.className ??= name;
  return klass;
};
ig.getClass ??= (name) => {
  if (!name) {
    return null;
  }

  const existingClass = ig.classes[name];
  if (existingClass) {
    return existingClass;
  }

  const globalClass = ig.global?.[name];
  return globalClass ? ig.registerClass(name, globalClass) : null;
};
ig.resolveClass ??= (type) => (typeof type === 'string' ? ig.getClass(type) : type);
ig.setNocache ??= (set) => {
  ig.nocache = set ? `?${Date.now()}` : '';
};
ig.log ??= () => {};
ig.assert ??= () => {};
ig.show ??= () => {};
ig.mark ??= () => {};
ig.getImagePixels ??= (image, x, y, width, height) => {
  const canvas = ig.$new('canvas');

  if (!canvas) {
    throw new Error('ig.getImagePixels requires a canvas-capable document');
  }

  canvas.width = image.width;
  canvas.height = image.height;

  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('ig.getImagePixels requires a 2D canvas context');
  }

  if (ig.System?.SCALE?.CRISP) {
    ig.System.SCALE.CRISP(canvas, context);
  }

  context.drawImage(image, 0, 0, image.width, image.height);

  return context.getImageData(x, y, width, height);
};
ig.boot = () => bootEnvironment();

ig.namespace = (namespacePath, root = ig.global) => {
  if (!namespacePath) {
    return root;
  }

  if (namespacePath === 'ig') {
    return ig;
  }

  if (namespacePath.startsWith('ig.')) {
    return createNamespace(ig, namespacePath.slice(3));
  }

  return createNamespace(root, namespacePath);
};

ig.copy = (object) => copy(ig, object);
ig.merge = (original, extended) => merge(ig, original, extended);
ig.ksort = ksort;

installClassSystem(ig);

globalScope.ig = ig;
bootEnvironment();

ig.debugReady = loadDebugFromUrl();

export default ig;
