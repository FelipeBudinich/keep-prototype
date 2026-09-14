import ig from "../../lib/impact/impact.js";
import { S } from "./strings.js";
import { card, dragon, palette, rounded, star, text } from "./cards.js";
import { canvasGameplay } from "./canvas-gameplay.js";
function short(ctx, value, width) {
  let out = String(value);
  while (ctx.measureText(out).width > width && out.length > 1) out = out.slice(0, -1);
  return out === String(value) ? out : `${out.slice(0, -1)}…`;
}
export function makeGame(store, transport, screens) {
  return ig.Game.extend({
    ...canvasGameplay(store, transport, screens),
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
    drawBoard(ctx, rect) {
      const v = store.view,
        g = v.game || {},
        w = rect.w,
        h = rect.h,
        mobile = w < 480;
      ctx.save();
      ctx.translate(rect.x, rect.y);
      this.targetOffset = rect;
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
        cy = h * 0.50,
        rx = w * (mobile ? 0.35 : 0.33),
        ry = h * 0.34;
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
        ph = mobile ? 94 : 100;
      const positions = ordered.map((p, i) => {
        const a = Math.PI / 2 + (i * Math.PI * 2) / ordered.length;
        if (mobile && ordered.length === 6) {
          const positions = [
            [0.5, 0.845],
            [0.18, 0.70],
            [0.18, 0.29],
            [0.5, 0.13],
            [0.82, 0.29],
            [0.82, 0.70],
          ];
          return { p, x: w * positions[i][0], y: h * positions[i][1], a };
        }
        return { p, x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, a };
      });
      positions.forEach((pos, i) => {
        const next = positions[(i + 1) % positions.length],
          a = pos.a + Math.PI / ordered.length,
          // Leave room for a pile in the passing lane, inside the seat panels.
          lane = ordered.length === 6
            ? 0.58
            : ordered.length === 5 && Math.sin(a) > 0
              ? mobile ? 0.62 : 0.57
              : 0.7,
          x = cx + Math.cos(a) * rx * lane,
          y = cy + Math.sin(a) * ry * (mobile && ordered.length === 6 ? 0.61 : lane);
        ctx.save();
        ctx.translate(x, y);
        // The origin stays fixed; the recipient identifies the latest pass.
        if (g.packet && next.p.playerId === g.packet.recipientPlayerId) {
          const packetW = mobile ? Math.min(ordered.length === 6 ? 28 : 30, w * 0.085) : ordered.length === 6 ? 28 : 38,
            packetH = packetW * 1.42;
          ctx.save();
          ctx.scale(packetW / 58, packetW / 58);
          for (let layer = Math.min(3, g.packet.count) - 1; layer >= 0; layer--)
            card(ctx, null, -29 + layer * 2, -58 * 1.42 / 2 - layer * 2, 58, 58 * 1.42, { back: true });
          ctx.restore();
          rounded(ctx, -9, packetH / 2 - 14, 18, 14, 4, "#f7edcf", "#bd8e36");
          text(ctx, String(g.packet.count), 0, packetH / 2 - 7, 11, palette.ink, "center", "Georgia");
        } else {
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
        }
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
      const bw = mobile ? Math.min(43, w * 0.12) : 58,
        bh = bw * 1.42,
        centerY = cy - bh / 2,
        deckX = cx - bw / 2;
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
        this.addTarget({
          x: deckX - 7,
          y: centerY - 8,
          w: bw + 14,
          h: bh + 50,
          id: "deck-draw",
          action: "draw",
          label: S.draw,
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
      text(ctx, S.right, w / 2, h - 9, 9, "#98a788", "center");
      ctx.restore();
      ctx.restore();
      this.targetOffset = null;
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
        short(ctx, label.toUpperCase(), w - 12),
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
      if (!mobile) text(
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
        mobile ? `${p.visibleGoblinCount} ${S.goblins}` : `${p.visibleGoblinCount} ${S.goblins} · ${p.handCount} ${S.handCount}`,
        x + w / 2,
        y + (mobile ? 64 : 70),
        mobile ? 8 : 9,
        "#68765e",
        "center",
      );
      if (mobile) text(ctx, `${p.handCount} ${S.handCount}`, x + w / 2, y + 76, 8, "#68765e", "center");
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
        this.addTarget({
          x,
          y,
          w,
          h,
          id: `seat-take:${p.playerId}`,
          action: "take",
          label: `${S.take} · ${p.displayName}`,
          dataset: { playerId: p.playerId },
        });
      }
    },
  });
}
