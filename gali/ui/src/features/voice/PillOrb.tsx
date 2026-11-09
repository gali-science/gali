import { useEffect, useRef } from "react";

export type PillOrbState = "idle" | "listening" | "thinking" | "talking";

type Props = {
  state: PillOrbState;
  /** 0–1 remote output level; drives talking brightness */
  volume: number;
  /** Increment to fire the tool-call satellite */
  toolPulse: number;
  centered?: boolean;
  className?: string;
};

type Sat = { a: number; orbits: number; fade: number };

export function PillOrb({ state, volume, toolPulse, centered, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  const volRef = useRef(volume);
  const centeredRef = useRef(centered === true);
  const satRef = useRef<Sat | null>(null);
  const lastPulseRef = useRef(toolPulse);
  stateRef.current = state;
  volRef.current = volume;
  centeredRef.current = centered === true;

  useEffect(() => {
    if (toolPulse === lastPulseRef.current) return;
    lastPulseRef.current = toolPulse;
    if (toolPulse > 0) satRef.current = { a: -Math.PI / 2, orbits: 0, fade: 1 };
  }, [toolPulse]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let W = 0;
    let H = 0;
    let dpr = 1;
    const phase = Math.random() * 100;
    let rawVol = 0;
    let vol = 0;
    let raf = 0;
    let alive = true;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      W = rect.width;
      H = rect.height;
      canvas.width = Math.max(1, Math.floor(W * dpr));
      canvas.height = Math.max(1, Math.floor(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const frame = (tms: number) => {
      if (!alive) return;
      const t = tms / 1000;
      const mode = stateRef.current;
      rawVol = mode === "talking" ? volRef.current * 100 : 0;
      vol += (rawVol - vol) * 0.25;

      const mid = centeredRef.current;
      const baseR = H * (mid ? 0.17 : 0.13);
      // Left-anchored in the pill glow well — keep this, don't tuck into the rim.
      const ax = mid ? W / 2 : H * 0.78;
      const ay = H * 0.5;
      const hoverY = Math.sin(t * 1.1 + phase) * 1.6;
      const hoverX = Math.sin(t * 0.7 + phase * 2) * 1.0;
      const px = ax + hoverX;
      const py = ay + hoverY;

      let r: number;
      let glow: number;

      if (mode === "talking") {
        r = baseR * (1 + vol / 300);
        glow = 1 + vol / 70;
      } else if (mode === "listening") {
        const pulse = Math.sin(t * 2.4);
        glow = 1.35 + pulse * 0.35;
        r = baseR * (1.12 + pulse * 0.05);
      } else if (mode === "thinking") {
        glow = 0.8 + Math.sin(t * 3.2) * 0.25;
        r = baseR * (1 + Math.sin(t * 3.2) * 0.03);
      } else if (mid) {
        glow = 0.95 + Math.sin(t * 0.9) * 0.12;
        r = baseR;
      } else {
        glow = 0.55 + Math.sin(t * 0.9) * 0.06;
        r = baseR * 0.94;
      }

      ctx.clearRect(0, 0, W, H);

      const layers = [
        { rr: r * 6.5, a: 0.06 * glow },
        { rr: r * 3.4, a: 0.14 * glow },
        { rr: r * 1.9, a: 0.32 * glow },
      ];
      for (const L of layers) {
        const rr = mid ? Math.min(L.rr, Math.min(W, H) / 2 - 1) : L.rr;
        const gg = ctx.createRadialGradient(px, py, 0, px, py, rr);
        gg.addColorStop(0, `rgba(176,208,255,${Math.min(L.a, 0.85)})`);
        gg.addColorStop(1, "rgba(176,208,255,0)");
        ctx.fillStyle = gg;
        ctx.beginPath();
        ctx.arc(px, py, rr, 0, Math.PI * 2);
        ctx.fill();
      }

      const cg = ctx.createRadialGradient(px, py, 0, px, py, r);
      cg.addColorStop(0, "#ffffff");
      cg.addColorStop(0.6, "#eaf3ff");
      cg.addColorStop(1, "rgba(234,243,255,0)");
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();

      const sat = satRef.current;
      if (sat) {
        sat.a += 0.028;
        if (sat.a > Math.PI * 1.5) {
          sat.a -= Math.PI * 2;
          sat.orbits++;
        }
        if (sat.orbits >= 2) sat.fade -= 0.008;
        if (sat.fade <= 0) {
          satRef.current = null;
        } else {
          const orbit = mid ? W * 0.3 : r * 2.4;
          const sx = px + Math.cos(sat.a) * orbit;
          const sy = py + Math.sin(sat.a) * orbit * 0.45;
          const behind = Math.sin(sat.a) < 0 ? 0.5 : 1;
          const sr = r * 0.18;
          const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr * 3);
          sg.addColorStop(0, `rgba(255,255,255,${0.9 * sat.fade * behind})`);
          sg.addColorStop(0.5, `rgba(176,208,255,${0.4 * sat.fade * behind})`);
          sg.addColorStop(1, "rgba(176,208,255,0)");
          ctx.fillStyle = sg;
          ctx.beginPath();
          ctx.arc(sx, sy, sr * 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className ? `pill-orb-canvas ${className}` : "pill-orb-canvas"}
      aria-hidden="true"
    />
  );
}
