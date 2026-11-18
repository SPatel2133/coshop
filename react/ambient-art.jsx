import React, { useEffect, useRef, useState } from "react";
import { useMedia } from "./ui.jsx";

const preference = "coshop:ambient-motion";
const glyphs = ".:+*/";
const points = Array.from({ length: 1400 }, (_, index) => {
  const y = 1 - (2 * (index + 0.5)) / 1400;
  const radius = Math.sqrt(1 - y * y);
  const angle = index * 2.399963229728653;
  return { x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius, angle };
});

function savedPreference() {
  try {
    return localStorage.getItem(preference);
  } catch {
    return null;
  }
}

export function AmbientArt() {
  const canvas = useRef(null);
  const elapsed = useRef(0);
  const reduced = useMedia("(prefers-reduced-motion: reduce)");
  const [choice, setChoice] = useState(savedPreference);
  const playing = !reduced && choice !== "off";

  useEffect(() => {
    const surface = canvas.current;
    const hero = surface.parentElement;
    const context = surface.getContext("2d");
    if (!context) return;
    let width = 0;
    let height = 0;
    let frame = 0;
    let last = 0;
    let visible = true;
    let x = 0;
    let y = 0;
    let targetX = 0;
    let targetY = 0;

    function draw() {
      context.clearRect(0, 0, width, height);
      x += (targetX - x) * 0.045;
      y += (targetY - y) * 0.045;
      const narrow = width < 760;
      const time = elapsed.current;
      const radius = narrow ? width * 0.22 : Math.min(width * 0.2, 270);
      context.font = (narrow ? "8px" : "10px") + " monospace";
      for (const side of [0, 1]) {
        const angle = time * (side ? -0.15 : 0.13) + side * 1.2 + x * 0.12;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const centerX = width * (side ? 0.985 : 0.015);
        const centerY = height * (side ? 0.43 : 0.64) + y * 9;
        for (let i = 0; i < points.length; i += narrow ? 3 : 1) {
          const point = points[i];
          const rx = point.x * cos + point.z * sin;
          const z = point.z * cos - point.x * sin;
          const ripple = 1 + 0.1 * Math.sin(point.y * 7 + time * 0.45) *
            Math.cos(point.angle * 3 + time * 0.3);
          const px = centerX + (rx * 0.92 + point.y * 0.25) * radius * ripple;
          const py = centerY + (point.y * 0.77 + rx * 0.19) * radius * ripple;
          const edge = Math.min(1, Math.max(0, (Math.abs(px / width - 0.5) - 0.23) / 0.16));
          const alpha = (0.11 + (z + 1) * 0.14) * edge * (narrow ? 0.8 : 1);
          if (alpha < 0.025) continue;
          context.fillStyle = `rgba(44, 93, 115, ${alpha.toFixed(3)})`;
          context.fillText(glyphs[i % glyphs.length], px, py);
        }
      }
    }

    function tick(now) {
      if (!last || now - last >= 32) {
        if (last) elapsed.current += Math.min(now - last, 50) / 1000;
        last = now;
        draw();
      }
      frame = requestAnimationFrame(tick);
    }

    function sync() {
      cancelAnimationFrame(frame);
      last = 0;
      if (playing && visible && !document.hidden)
        frame = requestAnimationFrame(tick);
    }

    function resize() {
      ({ width, height } = hero.getBoundingClientRect());
      const ratio = Math.min(devicePixelRatio, 1.5);
      surface.width = Math.round(width * ratio);
      surface.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (width) draw();
    }

    function move(event) {
      if (!playing || event.pointerType !== "mouse") return;
      const rect = hero.getBoundingClientRect();
      targetX = (event.clientX - rect.left) / rect.width - 0.5;
      targetY = (event.clientY - rect.top) / rect.height - 0.5;
    }

    function clearPointer() {
      targetX = targetY = 0;
    }

    const size = new ResizeObserver(resize);
    size.observe(hero);
    const visibility = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    visibility.observe(hero);
    hero.addEventListener("pointermove", move, { passive: true });
    hero.addEventListener("pointerleave", clearPointer);
    document.addEventListener("visibilitychange", sync);
    resize();
    sync();
    return () => {
      cancelAnimationFrame(frame);
      size.disconnect();
      visibility.disconnect();
      hero.removeEventListener("pointermove", move);
      hero.removeEventListener("pointerleave", clearPointer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [playing]);

  function toggle() {
    const next = playing ? "off" : "on";
    setChoice(next);
    try {
      localStorage.setItem(preference, next);
    } catch {}
  }

  return (
    <>
      <canvas ref={canvas} className="landing-ambient" aria-hidden="true" />
      <button
        type="button"
        className="quiet landing-motion"
        aria-label="Background motion"
        aria-pressed={playing}
        disabled={reduced}
        onClick={toggle}
      >
        Motion {playing ? "on" : "off"}
      </button>
    </>
  );
}
