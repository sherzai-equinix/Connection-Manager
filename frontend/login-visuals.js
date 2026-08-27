/* Animated trading/network background for the login page. */
(function () {
  "use strict";

  const canvas = document.getElementById("marketCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let values = [];
  let animationFrame = 0;
  let lastFrame = 0;
  let lastMarketTick = 0;

  function seedValues() {
    const count = Math.max(34, Math.ceil(width / 28) + 5);
    values = [];
    let value = 0.48;
    for (let i = 0; i < count; i += 1) {
      value = Math.max(0.16, Math.min(0.84, value + (Math.random() - 0.46) * 0.13));
      values.push(value);
    }
  }

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seedValues();
  }

  function palette() {
    const light = document.body.classList.contains("light-mode");
    return light ? {
      grid: "rgba(37,99,235,.055)",
      candleUp: "rgba(13,148,136,.22)",
      candleDown: "rgba(59,130,246,.16)",
      line: "rgba(14,165,164,.42)",
      glow: "rgba(37,99,235,.12)",
      areaTop: "rgba(14,165,164,.105)",
      areaBottom: "rgba(37,99,235,0)",
      node: "rgba(37,99,235,.18)",
    } : {
      grid: "rgba(96,165,250,.055)",
      candleUp: "rgba(45,212,191,.28)",
      candleDown: "rgba(96,165,250,.22)",
      line: "rgba(45,212,191,.52)",
      glow: "rgba(37,99,235,.2)",
      areaTop: "rgba(14,165,164,.13)",
      areaBottom: "rgba(37,99,235,0)",
      node: "rgba(96,165,250,.22)",
    };
  }

  function advanceMarket(time) {
    if (time - lastMarketTick < 720 || !values.length) return;
    lastMarketTick = time;
    const previous = values[values.length - 1];
    const next = Math.max(0.14, Math.min(0.86, previous + (Math.random() - 0.455) * 0.14));
    values.push(next);
    values.shift();
  }

  function drawGrid(colors, time) {
    const spacing = 56;
    const drift = reducedMotion ? 0 : (time * 0.006) % spacing;
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = -spacing + drift; x < width + spacing; x += spacing) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = -spacing + drift * 0.35; y < height + spacing; y += spacing) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
  }

  function chartPoints() {
    const spacing = width / Math.max(1, values.length - 1);
    const top = height * 0.17;
    const range = height * 0.58;
    return values.map((value, index) => ({
      x: index * spacing,
      y: top + (1 - value) * range,
      value,
    }));
  }

  function drawCandles(points, colors) {
    const candleWidth = Math.max(3, Math.min(8, width / values.length * 0.28));
    for (let i = 2; i < points.length - 1; i += 3) {
      const point = points[i];
      const previous = points[i - 1];
      const rising = point.value >= previous.value;
      const color = rising ? colors.candleUp : colors.candleDown;
      const bodyTop = Math.min(point.y, previous.y);
      const bodyHeight = Math.max(4, Math.abs(point.y - previous.y));
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(point.x, bodyTop - 13);
      ctx.lineTo(point.x, bodyTop + bodyHeight + 13);
      ctx.stroke();
      ctx.fillRect(point.x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
    }
  }

  function drawMarketLine(points, colors, time) {
    if (points.length < 2) return;
    const gradient = ctx.createLinearGradient(0, height * 0.2, 0, height * 0.8);
    gradient.addColorStop(0, colors.areaTop);
    gradient.addColorStop(1, colors.areaBottom);

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
    ctx.lineTo(width, height * 0.82);
    ctx.lineTo(0, height * 0.82);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.save();
    ctx.shadowBlur = 18;
    ctx.shadowColor = colors.glow;
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
    ctx.restore();

    const travel = reducedMotion ? 0.72 : (time * 0.00009) % 1;
    const index = Math.min(points.length - 2, Math.floor(travel * (points.length - 1)));
    const local = travel * (points.length - 1) - index;
    const a = points[index];
    const b = points[index + 1];
    const x = a.x + (b.x - a.x) * local;
    const y = a.y + (b.y - a.y) * local;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.shadowBlur = 16;
    ctx.shadowColor = colors.line;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function drawNetwork(colors, time) {
    const y = height * 0.86;
    const nodes = [0.08, 0.24, 0.43, 0.65, 0.86].map((ratio, index) => ({
      x: width * ratio,
      y: y + Math.sin(index * 1.8) * 18,
    }));
    ctx.strokeStyle = colors.node;
    ctx.lineWidth = 1;
    ctx.beginPath();
    nodes.forEach((node, index) => {
      if (!index) ctx.moveTo(node.x, node.y);
      else ctx.lineTo(node.x, node.y);
    });
    ctx.stroke();
    nodes.forEach((node, index) => {
      const pulse = reducedMotion ? 0 : Math.sin(time * 0.002 + index) * 1.5;
      ctx.beginPath();
      ctx.arc(node.x, node.y, 3.5 + pulse, 0, Math.PI * 2);
      ctx.fillStyle = index === nodes.length - 1 ? "rgba(45,212,191,.65)" : colors.node;
      ctx.fill();
    });
  }

  function render(time = 0) {
    if (!reducedMotion && time - lastFrame < 32) {
      animationFrame = requestAnimationFrame(render);
      return;
    }
    lastFrame = time;
    advanceMarket(time);
    ctx.clearRect(0, 0, width, height);
    const colors = palette();
    drawGrid(colors, time);
    const points = chartPoints();
    drawCandles(points, colors);
    drawMarketLine(points, colors, time);
    drawNetwork(colors, time);
    if (!reducedMotion) animationFrame = requestAnimationFrame(render);
  }

  resize();
  window.addEventListener("resize", resize, { passive: true });
  document.addEventListener("visibilitychange", () => {
    cancelAnimationFrame(animationFrame);
    if (document.visibilityState === "visible" && !reducedMotion) {
      animationFrame = requestAnimationFrame(render);
    }
  });
  if (reducedMotion) render(0);
  else animationFrame = requestAnimationFrame(render);
})();
