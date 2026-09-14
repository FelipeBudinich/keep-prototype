import ig from "../../lib/impact/impact.js";
import { S } from "./strings.js";
import { card, dragon, icon, palette, rounded, star, text } from "./cards.js";
import { Presentation } from "./animations.js";
function short(ctx, value, width) {
  let out = String(value);
  while (ctx.measureText(out).width > width && out.length > 1)
    out = out.slice(0, -1);
  return out === value ? out : `${out.slice(0, -1)}…`;
}
export function makeGame(store, transport) {
  return ig.Game.extend({
    init() {
      this.store = store;
      this.transport = transport;
      this.presentation = new Presentation();
      this.targets = [];
      this.handTargets = [];
      this.lastHand = "";
      this.width = 0;
      this.height = 0;
      this.scale = 1;
      ig.input.bind("MousePrimary", "activate");
      ig.input.bind("KeyD", "draw");
      ig.input.bind("KeyP", "pass");
      ig.input.bind("KeyR", "reveal");
      ig.input.bind("Escape", "clear");
      this.handCanvas = document.querySelector("#hand-canvas");
      this.handContext = this.handCanvas.getContext("2d");
      this.handCanvas.addEventListener("click", (event) => {
        const r = this.handCanvas.getBoundingClientRect(),
          x = event.clientX - r.left,
          y = event.clientY - r.top;
        const hit = this.handTargets.find(
          (t) => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h,
        );
        if (hit) store.toggle(hit.handle);
      });
    },
    update() {
      const width = Math.max(
        280,
        Math.round(
          document.querySelector(".canvas-wrap").getBoundingClientRect().width,
        ),
      );
      const mobile = width < 480,
        table = store.screen === "table",
        height = table
          ? mobile
            ? 430
            : 450
          : Math.min(590, Math.max(280, width * 1.04));
      const scale = Math.min(2, window.devicePixelRatio || 1);
      if (
        width !== this.width ||
        height !== this.height ||
        scale !== this.scale
      ) {
        this.width = width;
        this.height = height;
        this.scale = scale;
        ig.system.resize(width, height, scale);
        ig.system.canvas.style.height = `${height}px`;
        ig.system.canvas.style.width = "100%";
      }
      this.presentation.observe(store.view);
      if (ig.input.pressed("activate")) {
        const p = ig.input.mouse,
          hit = this.targets.find(
            (t) =>
              p.x >= t.x && p.x <= t.x + t.w && p.y >= t.y && p.y <= t.y + t.h,
          );
        if (hit && store.allowed(hit.type))
          transport.send(hit.type, hit.payload || {});
      }
      if (document.activeElement === ig.system.canvas) {
        for (const [key, type] of [
          ["draw", "DRAW_CARD"],
          ["pass", "PASS_PACKET"],
          ["reveal", "REVEAL_PACKET_TOP"],
        ])
          if (ig.input.pressed(key) && store.allowed(type))
            transport.send(type);
        if (ig.input.pressed("clear")) {
          store.draft = [];
          store.emit();
        }
      }
      ig.system.canvas.style.cursor = this.targets.some(
        (t) =>
          ig.input.mouse.x >= t.x &&
          ig.input.mouse.x <= t.x + t.w &&
          ig.input.mouse.y >= t.y &&
          ig.input.mouse.y <= t.y + t.h &&
          store.allowed(t.type),
      )
        ? "pointer"
        : "default";
    },
    draw() {
      const ctx = ig.system.context;
      ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);
      this.targets = [];
      if (store.screen === "table" && store.view) this.drawTable(ctx);
      else this.drawHero(ctx);
      if (store.screen === "table") this.drawHand();
    },
    drawHero(ctx) {
      ig.system.canvas.setAttribute("aria-label", S.heroDescription);
      const w = this.width,
        h = this.height,
        cx = w * 0.51,
        cy = h * 0.36,
        r = Math.min(w * 0.32, h * (h < 440 ? 0.26 : 0.29), 174);
      ctx.save();
      ctx.strokeStyle = "#d5c8a8";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 24, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, r + 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, r - 4, 0, Math.PI * 2);
      ctx.fillStyle = "#e9e1c9";
      ctx.fill();
      for (let i = 0; i < 40; i++) {
        const a = (i * Math.PI * 2) / 40;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * (r + 20), cy + Math.sin(a) * (r + 20));
        ctx.lineTo(cx + Math.cos(a) * (r + 24), cy + Math.sin(a) * (r + 24));
        ctx.stroke();
      }
      dragon(ctx, cx - 2, cy - 4, r * 1.53);
      star(ctx, cx - r * 0.73, cy - r * 0.44, 6);
      star(ctx, cx + r * 0.75, cy + r * 0.28, 8);
      star(ctx, cx + r * 0.5, cy - r * 0.65, 4);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-0.18);
      ctx.fillStyle = "#f4eedf";
      ctx.fillRect(-46, -r - 35, 92, 25);
      text(ctx, S.myth, 0, -r - 23, 9, "#94815c", "center");
      ctx.restore();
      const compact = h < 440,
        cw = Math.min(127, w * 0.245, compact ? h * 0.195 : 127),
        ch = cw * 1.46,
        base = h * (compact ? 0.55 : 0.57);
      card(ctx, "GOBLIN", cx - cw * 1.46, base + 20, cw, ch, {
        rotation: -0.19,
      });
      card(ctx, "ADVENTURER", cx + cw * 0.44, base + 20, cw, ch, {
        rotation: 0.19,
      });
      card(ctx, "TREASURE", cx - cw * 0.5, base - 1, cw, ch, {
        rotation: -0.025,
      });
      text(ctx, S.subtitle, w / 2, h - (compact ? 12 : 30), 15, "#69705d", "center", "Georgia");
      for (const [x, y] of [
        [w * 0.08, h * 0.21],
        [w * 0.88, h * 0.48],
        [w * 0.19, h * 0.87],
      ])
        star(ctx, x, y, 6, "#b79a59");
      ctx.restore();
    },
    drawTable(ctx) {
      const v = store.view,
        g = v.game || {},
        w = this.width,
        h = this.height,
        mobile = w < 480;
      rounded(ctx, 0, 0, w, h, 12, palette.green);
      ctx.save();
      rounded(ctx, 11, 11, w - 22, h - 22, 9, null, "#56705a");
      rounded(ctx, 16, 16, w - 32, h - 32, 6, null, "#294c3b");
      for (const [x, y] of [
        [29, 29],
        [w - 29, 29],
        [29, h - 29],
        [w - 29, h - 29],
      ])
        star(ctx, x, y, 5, "#83906a");
      const cx = w / 2,
        cy = h * 0.49,
        rx = w * (mobile ? 0.35 : 0.33),
        ry = h * 0.35;
      ctx.strokeStyle = "#6e815845";
      ctx.setLineDash([2, 8]);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      const players = [...v.players].sort((a, b) => a.seatIndex - b.seatIndex),
        selfIndex = players.findIndex((p) => p.playerId === v.self.playerId),
        ordered = players.slice(selfIndex).concat(players.slice(0, selfIndex));
      const pw = mobile ? Math.min(99, w * 0.26) : Math.min(162, w * 0.22),
        ph = mobile ? 84 : 100;
      const positions = ordered.map((p, i) => {
        const a = Math.PI / 2 + (i * Math.PI * 2) / ordered.length;
        if (mobile && ordered.length === 6) {
          const positions = [
            [0.5, 0.87],
            [0.18, 0.65],
            [0.18, 0.29],
            [0.5, 0.105],
            [0.82, 0.29],
            [0.82, 0.65],
          ];
          return { p, x: w * positions[i][0], y: h * positions[i][1], a };
        }
        return { p, x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, a };
      });
      positions.forEach((pos, i) => {
        const next = positions[(i + 1) % positions.length];
        let a = pos.a + Math.PI / ordered.length;
        const x = cx + Math.cos(a) * rx,
          y = cy + Math.sin(a) * ry;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a + Math.PI / 2);
        ctx.strokeStyle = "#aab58a";
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(-6, -4);
        ctx.lineTo(0, 0);
        ctx.lineTo(-6, 4);
        ctx.moveTo(-15, 0);
        ctx.lineTo(0, 0);
        ctx.stroke();
        ctx.restore();
        this.drawSeat(
          ctx,
          pos.p,
          pos.x - pw / 2,
          pos.y - ph / 2,
          pw,
          ph,
          mobile,
        );
      });
      // Only counts and the same generic card back are used for either hidden zone.
      const bw = mobile ? 43 : 58,
        bh = bw * 1.42,
        centerY = cy - 38,
        deckX = cx - bw - 14,
        packetX = cx + 14;
      for (let i = Math.min(3, g.drawPileCount || 0) - 1; i >= 0; i--)
        card(ctx, null, deckX - i * 2, centerY - i * 2, bw, bh, { back: true });
      if (!g.drawPileCount) {
        rounded(ctx, deckX, centerY, bw, bh, 5, null, "#61735a");
        text(
          ctx,
          "0",
          deckX + bw / 2,
          centerY + bh / 2,
          24,
          "#819076",
          "center",
          "Georgia",
        );
      }
      text(
        ctx,
        String(g.drawPileCount ?? 0),
        deckX + bw / 2,
        centerY + bh + 15,
        16,
        "#e9d6a6",
        "center",
        "Georgia",
      );
      text(
        ctx,
        S.drawPile,
        deckX + bw / 2,
        centerY + bh + 32,
        mobile ? 9 : 10,
        "#bec8ad",
        "center",
      );
      if (store.allowed("DRAW_CARD")) {
        this.targets.push({
          x: deckX - 7,
          y: centerY - 8,
          w: bw + 14,
          h: bh + 50,
          type: "DRAW_CARD",
        });
        rounded(
          ctx,
          deckX - 6,
          centerY - 7,
          bw + 12,
          bh + 14,
          7,
          null,
          "#e8c374",
        );
      }
      if (g.packet) {
        for (let i = Math.min(3, g.packet.count) - 1; i >= 0; i--)
          card(ctx, null, packetX + i * 2, centerY - i * 2, bw, bh, {
            back: true,
          });
        text(
          ctx,
          String(g.packet.count),
          packetX + bw / 2,
          centerY + bh + 15,
          16,
          "#e9d6a6",
          "center",
          "Georgia",
        );
        text(
          ctx,
          S.packet,
          packetX + bw / 2,
          centerY + bh + 32,
          mobile ? 9 : 10,
          "#bec8ad",
          "center",
        );
      } else {
        rounded(ctx, packetX, centerY, bw, bh, 5, null, "#61735a");
        star(ctx, packetX + bw / 2, centerY + bh / 2, 10, "#61735a");
        text(
          ctx,
          S.faceDown,
          packetX + bw / 2,
          centerY + bh + 15,
          mobile ? 8 : 9,
          "#8c9d82",
          "center",
        );
      }
      text(ctx, S.right, w / 2, h - 18, 9, "#98a788", "center");
      ctx.restore();
      const summary = players
        .map(
          (p) =>
            `${p.displayName}, ${p.visibleTreasureCount} ${S.treasures}, ${p.visibleGoblinCount} ${S.goblins}, ${p.handCount} ${S.handCount}`,
        )
        .join("; ");
      ig.system.canvas.setAttribute(
        "aria-label",
        `${S.table}. ${summary}. ${S.drawPile}: ${g.drawPileCount}. ${g.packet ? `${S.packet}: ${g.packet.count}.` : ""}`,
      );
    },
    drawSeat(ctx, p, x, y, w, h, mobile) {
      const v = store.view,
        g = v.game || {},
        isSelf = p.playerId === v.self.playerId,
        active = p.playerId === g.activePlayerId,
        deciding = p.playerId === g.decision?.playerId,
        donor =
          store.allowed("TAKE_RANDOM_CARD") &&
          v.allowedCommands.legalTakeTargetPlayerIds.includes(p.playerId),
        winner = p.playerId === g.winnerPlayerId;
      const glow = this.presentation.glow();
      if (deciding) {
        ctx.save();
        ctx.shadowBlur = glow * 13;
        ctx.shadowColor = "#e3bb6c";
        rounded(ctx, x - 3, y - 3, w + 6, h + 6, 10, null, "#e8c374");
        ctx.restore();
      }
      rounded(
        ctx,
        x,
        y,
        w,
        h,
        7,
        isSelf ? "#f7edcf" : "#e9e4cb",
        winner || donor ? "#e8b659" : null,
      );
      text(ctx, `${p.seatIndex + 1}`, x + 12, y + 13, 9, "#8e8260", "center");
      ctx.font = `${mobile ? 11 : 12}px Arial`;
      text(
        ctx,
        short(ctx, p.displayName, w - 32),
        x + w / 2,
        y + 15,
        mobile ? 11 : 12,
        palette.ink,
        "center",
      );
      let label = winner
        ? S.won
        : deciding
          ? S.deciding
          : active
            ? S.active
            : isSelf
              ? S.you
              : p.kind === "BOT"
                ? S.bot
                : S.human;
      text(
        ctx,
        label.toUpperCase(),
        x + w / 2,
        y + 30,
        mobile ? 7 : 8,
        active ? "#996d24" : "#718168",
        "center",
      );
      // Fixed public progress slots; there are no card identities or hidden faces here.
      const circles = mobile ? 14 : 17,
        spacing = circles + 7,
        start = x + w / 2 - spacing;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(start + i * spacing, y + 50, circles / 2, 0, Math.PI * 2);
        ctx.fillStyle = i < p.visibleTreasureCount ? "#c49945" : "#d9d4bc";
        ctx.fill();
        if (i < p.visibleTreasureCount)
          star(ctx, start + i * spacing, y + 50, 4, "#fff2c6");
      }
      text(
        ctx,
        `${Math.min(3, p.visibleTreasureCount)}/3`,
        x + w - 12,
        y + 50,
        8,
        "#887348",
        "center",
      );
      text(
        ctx,
        `${p.visibleGoblinCount} ${S.goblins} · ${p.handCount} ${S.handCount}`,
        x + w / 2,
        y + (mobile ? 64 : 70),
        mobile ? 8 : 9,
        "#68765e",
        "center",
      );
      if (p.controllerMode === "TEMP_BOT" || (!p.connected && p.kind !== "BOT"))
        text(
          ctx,
          p.controllerMode === "TEMP_BOT" ? S.temporary : S.disconnected,
          x + w / 2,
          y + h - 8,
          mobile ? 7 : 8,
          "#996944",
          "center",
        );
      else if (active) {
        star(ctx, x + 11, y + 30, 4, "#bd8e36");
      }
      if (donor) {
        rounded(ctx, x - 3, y - 3, w + 6, h + 6, 10, null, "#e8c374");
        this.targets.push({
          x,
          y,
          w,
          h,
          type: "TAKE_RANDOM_CARD",
          payload: { targetPlayerId: p.playerId },
        });
      }
    },
    drawHand() {
      const hand = store.view?.self.hand || [],
        cw = 103,
        ch = 145,
        gap = 13,
        pad = 13,
        logicalWidth = Math.max(
          document.querySelector(".hand-scroll").clientWidth,
          hand.length * (cw + gap) + pad,
        ),
        logicalHeight = 174;
      const key = JSON.stringify([hand, store.draft, logicalWidth, this.scale]);
      if (key === this.lastHand) return;
      this.lastHand = key;
      this.handCanvas.width = logicalWidth * this.scale;
      this.handCanvas.height = logicalHeight * this.scale;
      this.handCanvas.style.width = `${logicalWidth}px`;
      this.handCanvas.style.height = `${logicalHeight}px`;
      const ctx = this.handContext;
      ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      ctx.clearRect(0, 0, logicalWidth, logicalHeight);
      this.handTargets = [];
      hand.forEach((c, i) => {
        const selected = store.draft.includes(c.handle),
          x = pad + i * (cw + gap),
          y = selected ? 5 : 13;
        card(ctx, c.type, x, y, cw, ch, { selected, index: i });
        this.handTargets.push({ x, y, w: cw, h: ch, handle: c.handle });
        if (selected) {
          rounded(ctx, x + cw - 23, y - 3, 25, 23, 12, "#b88a36");
          text(
            ctx,
            String(store.draft.indexOf(c.handle) + 1),
            x + cw - 10,
            y + 9,
            11,
            "#fff8e7",
            "center",
          );
        }
      });
      if (!hand.length)
        text(ctx, S.noHand, 24, 77, 17, "#7b856c", "left", "Georgia");
      this.handCanvas.setAttribute(
        "aria-label",
        `${S.hand}. ${hand.map((c) => S[c.type.toLowerCase()]).join(", ")}`,
      );
    },
  });
}
