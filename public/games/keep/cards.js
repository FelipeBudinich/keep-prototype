import { S, cardLabel } from "./strings.js";
export const palette = {
  ink: "#233f34",
  green: "#163e32",
  paper: "#fff8e7",
  gold: "#c49849",
  line: "#d0bc8b",
  muted: "#789183",
  red: "#a6573c",
};
export function rounded(ctx, x, y, w, h, r = 8, fill, stroke) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
export function text(
  ctx,
  value,
  x,
  y,
  size = 12,
  color = palette.ink,
  align = "left",
  font = "Arial",
) {
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.font = `${size}px ${font}`;
  ctx.fillText(value, x, y);
}
export function star(ctx, x, y, r, color = palette.gold) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.quadraticCurveTo(r * 0.18, -r * 0.18, r, 0);
  ctx.quadraticCurveTo(r * 0.18, r * 0.18, 0, r);
  ctx.quadraticCurveTo(-r * 0.18, r * 0.18, -r, 0);
  ctx.quadraticCurveTo(-r * 0.18, -r * 0.18, 0, -r);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}
export function dragon(ctx, x, y, size, color = palette.ink) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 200, size / 200);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.1;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // An engraved dragon curled around its own hoard.
  const wing = new Path2D(
    "M12 22 C-24 -2 -49 -40 -50 -88 L-28 -69 L-11 -95 L1 -66 L20 -89 L32 -45 L55 -50 L40 -13 Z",
  );
  ctx.fill(wing);
  ctx.strokeStyle = "#c6a466";
  ctx.lineWidth = 0.9;
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(12, 22);
    ctx.quadraticCurveTo(-8, -22, -46 + i * 22, -72 + (i % 2) * 14);
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  const body = new Path2D(
    "M43 -4 C83 11 78 61 39 80 C5 95 -35 79 -42 55 C-49 33 -29 15 -6 26 C-24 25 -29 46 -13 57 C11 79 42 56 35 36 C31 24 14 22 4 26 L-3 9 C0 -1 11 -5 18 -7 L22 -27 L11 -34 L13 -48 L30 -47 L36 -65 L43 -49 L55 -59 L57 -38 L78 -27 L79 -11 L60 -7 L59 2 Z",
  );
  ctx.fill(body);
  ctx.strokeStyle = "#c6a466";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(17, 16);
  ctx.bezierCurveTo(68, 21, 55, 71, 14, 69);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(23, -3);
  ctx.lineTo(43, -1);
  ctx.lineTo(52, -11);
  ctx.stroke();
  ctx.fillStyle = "#efdb9e";
  ctx.beginPath();
  ctx.arc(52, -28, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(53, -28, 1.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(-19, 63);
  ctx.bezierCurveTo(-53, 88, -75, 63, -64, 44);
  ctx.bezierCurveTo(-57, 33, -59, 22, -67, 19);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-67, 19);
  ctx.lineTo(-75, 24);
  ctx.lineTo(-71, 11);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(34, 42);
  ctx.lineTo(52, 45);
  ctx.lineTo(64, 57);
  ctx.moveTo(61, 57);
  ctx.lineTo(66, 55);
  ctx.moveTo(64, 57);
  ctx.lineTo(65, 61);
  ctx.stroke();
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.arc(12 + i * 8, 43 - i * 2, 2, 0, Math.PI);
    ctx.strokeStyle = "#c6a466";
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }
  ctx.restore();
}
export function icon(ctx, type, x, y, size = 60) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 100, size / 100);
  ctx.strokeStyle = palette.ink;
  ctx.fillStyle = palette.gold;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (type === "TREASURE") {
    ctx.beginPath();
    ctx.moveTo(-33, -12);
    ctx.lineTo(-24, -36);
    ctx.lineTo(25, -36);
    ctx.lineTo(35, -12);
    ctx.closePath();
    ctx.fillStyle = "#b98735";
    ctx.fill();
    ctx.stroke();
    rounded(ctx, -34, -13, 69, 45, 3, "#d8b669", palette.ink);
    ctx.fillStyle = "#f0d59a";
    ctx.fillRect(-24, -10, 7, 39);
    ctx.fillRect(18, -10, 7, 39);
    ctx.strokeRect(-5, -7, 11, 16);
    ctx.fillStyle = palette.ink;
    ctx.beginPath();
    ctx.arc(0.5, -1, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0.5, 0);
    ctx.lineTo(0.5, 5);
    ctx.stroke();
    star(ctx, 40, -32, 11);
    star(ctx, -40, -23, 6);
    star(ctx, 0, -53, 5);
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.ellipse(32 + i * 3, 35 - i * 6, 12, 4, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#dec783";
      ctx.fill();
      ctx.stroke();
    }
  } else if (type === "GOBLIN") {
    ctx.beginPath();
    ctx.moveTo(-24, -18);
    ctx.lineTo(-49, -34);
    ctx.lineTo(-39, -5);
    ctx.lineTo(-22, 0);
    ctx.moveTo(24, -18);
    ctx.lineTo(49, -34);
    ctx.lineTo(39, -5);
    ctx.lineTo(22, 0);
    ctx.fillStyle = "#7d926b";
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, -8, 28, 34, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-28, -15);
    ctx.quadraticCurveTo(-33, -54, 10, -49);
    ctx.lineTo(28, -25);
    ctx.lineTo(0, -33);
    ctx.closePath();
    ctx.fillStyle = palette.ink;
    ctx.fill();
    ctx.fillStyle = "#fff4d3";
    ctx.beginPath();
    ctx.ellipse(-12, -11, 7, 4, 0.2, 0, Math.PI * 2);
    ctx.ellipse(12, -11, 7, 4, -0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = palette.ink;
    ctx.beginPath();
    ctx.arc(-11, -11, 2.3, 0, Math.PI * 2);
    ctx.arc(11, -11, 2.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(-4, 7);
    ctx.lineTo(5, 7);
    ctx.moveTo(-11, 17);
    ctx.quadraticCurveTo(0, 22, 13, 15);
    ctx.stroke();
    ctx.fillStyle = "#fff4d3";
    ctx.beginPath();
    ctx.moveTo(-11, 18);
    ctx.lineTo(-8, 10);
    ctx.lineTo(-4, 20);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(11, 18);
    ctx.lineTo(8, 10);
    ctx.lineTo(4, 20);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-22, 21);
    ctx.quadraticCurveTo(-33, 28, -33, 44);
    ctx.lineTo(33, 44);
    ctx.quadraticCurveTo(33, 28, 22, 21);
    ctx.lineTo(0, 33);
    ctx.closePath();
    ctx.fillStyle = palette.ink;
    ctx.fill();
  } else if (type === "ADVENTURER") {
    ctx.beginPath();
    ctx.moveTo(-24, -16);
    ctx.quadraticCurveTo(-23, -53, 2, -50);
    ctx.quadraticCurveTo(30, -48, 27, -11);
    ctx.lineTo(17, -5);
    ctx.lineTo(17, 20);
    ctx.lineTo(-17, 20);
    ctx.lineTo(-17, -7);
    ctx.closePath();
    ctx.fillStyle = "#bd7554";
    ctx.fill();
    ctx.stroke();
    rounded(ctx, -19, -27, 38, 31, 3, "#eed3a4", palette.ink);
    ctx.fillStyle = palette.ink;
    ctx.fillRect(-14, -20, 28, 4);
    ctx.beginPath();
    ctx.moveTo(-2, -18);
    ctx.lineTo(-2, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-17, 12);
    ctx.lineTo(-33, 26);
    ctx.lineTo(-29, 44);
    ctx.lineTo(29, 44);
    ctx.lineTo(33, 26);
    ctx.lineTo(17, 12);
    ctx.lineTo(0, 24);
    ctx.closePath();
    ctx.fillStyle = "#a7593f";
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = palette.ink;
    ctx.fillRect(-4, 24, 8, 20);
    ctx.save();
    ctx.rotate(0.5);
    ctx.beginPath();
    ctx.moveTo(37, -41);
    ctx.lineTo(31, -27);
    ctx.lineTo(33, 24);
    ctx.lineTo(41, 24);
    ctx.lineTo(43, -27);
    ctx.closePath();
    ctx.fillStyle = "#dad5be";
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(25, 23);
    ctx.lineTo(49, 23);
    ctx.moveTo(37, 23);
    ctx.lineTo(37, 40);
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.restore();
  } else {
    dragon(ctx, 0, 1, 100, palette.gold);
  }
  ctx.restore();
}
export function card(
  ctx,
  type,
  x,
  y,
  w = 104,
  h = 148,
  { selected = false, index = null, back = false, rotation = 0 } = {},
) {
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(rotation);
  x = -w / 2;
  y = -h / 2;
  ctx.shadowColor = "#1b2e2624";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;
  rounded(ctx, x, y, w, h, 7, back ? palette.green : palette.paper);
  ctx.shadowColor = "transparent";
  rounded(
    ctx,
    x + 5,
    y + 5,
    w - 10,
    h - 10,
    4,
    null,
    selected ? "#ae7931" : back ? "#a68950" : "#d6c49b",
  );
  if (selected) {
    ctx.strokeStyle = "#bd8b39";
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }
  if (back) {
    rounded(ctx, x + 10, y + 10, w - 20, h - 20, 2, null, "#64785b");
    dragon(ctx, 0, -4, w * 0.75, "#c3a565");
    star(ctx, 0, y + 20, 4);
    star(ctx, 0, y + h - 20, 4);
  } else {
    const color =
      type === "TREASURE"
        ? "#b68a36"
        : type === "GOBLIN"
          ? "#677d50"
          : "#a95f42";
    text(
      ctx,
      index !== null ? String(index + 1) : "✦",
      x + 14,
      y + 16,
      10,
      color,
    );
    text(ctx, "✦", x + w - 14, y + h - 16, 10, color);
    icon(ctx, type, 0, y + h * 0.43, w * 0.64);
    text(
      ctx,
      cardLabel(type),
      0,
      y + h * 0.79,
      w * 0.13,
      palette.ink,
      "center",
      "Georgia",
    );
    ctx.strokeStyle = "#d6c49b";
    ctx.beginPath();
    ctx.moveTo(x + 18, y + h * 0.68);
    ctx.lineTo(x + w - 18, y + h * 0.68);
    ctx.stroke();
  }
  ctx.restore();
}
