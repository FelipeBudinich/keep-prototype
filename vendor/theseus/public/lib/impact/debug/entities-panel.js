import ig from '../ig.js';
import '../entity.js';
import './menu.js';

const drawDebugLine = (color, sx, sy, dx, dy) => {
  const ctx = ig.system.context;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ig.system.getDrawPos(sx - ig.game.screen.x), ig.system.getDrawPos(sy - ig.game.screen.y));
  ctx.lineTo(ig.system.getDrawPos(dx - ig.game.screen.x), ig.system.getDrawPos(dy - ig.game.screen.y));
  ctx.stroke();
};

ig.Entity._debugEnableChecks = true;
ig.Entity._debugShowBoxes = false;
ig.Entity._debugShowVelocities = false;
ig.Entity._debugShowNames = false;

ig.Entity.inject({
  debugColors: {
    boxes: '#ff4d4d',
    names: '#ffffff',
    velocities: '#6cff6c',
  },

  draw: function() {
    this.parent();

    const ctx = ig.system.context;
    const colors = this.debugColors;

    if (ig.Entity._debugShowBoxes) {
      ctx.strokeStyle = colors.boxes;
      ctx.lineWidth = 1;
      ctx.strokeRect(
        ig.system.getDrawPos(Math.round(this.pos.x) - ig.game.screen.x) - 0.5,
        ig.system.getDrawPos(Math.round(this.pos.y) - ig.game.screen.y) - 0.5,
        this.size.x * ig.system.scale,
        this.size.y * ig.system.scale,
      );
    }

    if (ig.Entity._debugShowVelocities) {
      const x = this.pos.x + this.size.x / 2;
      const y = this.pos.y + this.size.y / 2;
      drawDebugLine(colors.velocities, x, y, x + this.vel.x, y + this.vel.y);
    }

    if (ig.Entity._debugShowNames) {
      if (this.name) {
        ctx.fillStyle = colors.names;
        ctx.fillText(
          this.name,
          ig.system.getDrawPos(this.pos.x - ig.game.screen.x),
          ig.system.getDrawPos(this.pos.y - ig.game.screen.y),
        );
      }

      if (typeof this.target === 'object') {
        for (const key in this.target) {
          const target = ig.game.getEntityByName(this.target[key]);
          if (target) {
            drawDebugLine(
              colors.names,
              this.pos.x + this.size.x / 2,
              this.pos.y + this.size.y / 2,
              target.pos.x + target.size.x / 2,
              target.pos.y + target.size.y / 2,
            );
          }
        }
      }
    }
  },
});

const originalCheckPair = ig.Entity.checkPair;
ig.Entity.checkPair = function(a, b) {
  if (!ig.Entity._debugEnableChecks) {
    return;
  }

  originalCheckPair(a, b);
};

ig.debug.addPanel({
  type: ig.DebugPanel,
  name: 'entities',
  label: 'Entities',
  options: [
    { name: 'Checks & Collisions', object: ig.Entity, property: '_debugEnableChecks' },
    { name: 'Show Collision Boxes', object: ig.Entity, property: '_debugShowBoxes' },
    { name: 'Show Velocities', object: ig.Entity, property: '_debugShowVelocities' },
    { name: 'Show Names & Targets', object: ig.Entity, property: '_debugShowNames' },
  ],
});
