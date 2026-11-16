// Event Horizon Code - Shader background (WebGL2, dependency-free)
//
// A black hole, in the style of the classic "Gargantua" look: a dark event
// horizon disc, a bright photon ring, and a tilted accretion disc whose far
// side is lensed up OVER the sphere while the near side passes in front -
// plus Doppler beaming (one side of the disc much brighter) and turbulent
// filaments. Tinted between hot amber and the app's cyan/violet so it reads
// as this app's sky rather than a copy of the film.
//
// Cheap by design: one fullscreen triangle, half-resolution framebuffer, a
// 3-octave fbm, and it stops entirely when hidden or set to 0.
// intensity prop: 0 = off (no RAF), 0.35 subtle, 1 full.

import { createEffect, onCleanup, onMount } from "solid-js";

const VERT = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`;

const FRAG = `#version 300 es
precision highp float;
uniform float uT; uniform float uI; uniform vec2 uRes;
out vec4 O;

const float PI = 3.14159265;

float hash(vec2 q){ return fract(sin(dot(q, vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 q){
  vec2 i=floor(q), f=fract(q); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y);
}
// 3-octave fbm: enough filament structure without the cost.
float fbm(vec2 q){
  float v=0.0, a=0.5;
  for(int k=0;k<3;k++){ v += a*noise(q); q*=2.03; a*=0.5; }
  return v;
}

// Hot disc palette: white-hot inner rim -> amber -> cyan/violet outer.
vec3 discColor(float rr, float heat){
  vec3 hot  = vec3(1.00, 0.93, 0.78);
  vec3 amber= vec3(1.00, 0.56, 0.22);
  vec3 cool = vec3(0.42, 0.72, 1.00);
  vec3 edge = vec3(0.55, 0.40, 0.95);
  vec3 c = mix(hot, amber, smoothstep(0.0, 0.55, rr));
  c = mix(c, cool, smoothstep(0.62, 1.0, rr));
  c = mix(c, edge, smoothstep(0.95, 1.25, rr) * 0.7);
  return c * heat;
}

void main(){
  vec2 uv = (gl_FragCoord.xy*2.0 - uRes) / min(uRes.x, uRes.y);
  vec2 c = uv - vec2(0.0, 0.015);
  float r = length(c);
  float ang = atan(c.y, c.x);
  float t = uT;

  // ---- background: faint nebula wash + parallax starfield ----
  vec3 col = vec3(0.0);
  col += vec3(0.020, 0.026, 0.055) * fbm(uv*1.6 + vec2(t*0.01, -t*0.008));
  col += vec3(0.03, 0.02, 0.06) * smoothstep(1.6, 0.2, r); // violet depth toward center

  float stars = 0.0;
  for (int k=0;k<2;k++){
    float sc = 20.0 + float(k)*30.0;
    vec2 g = uv*sc + vec2(t*0.02*float(k+1), -t*0.012*float(k+1));
    vec2 id = floor(g); vec2 f = fract(g)-0.5;
    float h = hash(id);
    if (h > 0.9865) stars += smoothstep(0.09,0.0,length(f)) * (0.35+0.65*h);
  }
  col += stars * vec3(0.85, 0.92, 1.0) * 0.55;

  // ---- black hole geometry ----
  const float BH   = 0.215;           // event-horizon radius (screen units)
  const float TILT = 1.06;            // disc inclination: ~61 deg from face-on
  const float RIN  = 0.34;            // inner disc edge (disc space)
  const float ROUT = 0.96;            // outer disc edge
  const float COST = cos(TILT);       // vertical squash of the disc on screen

  // Disc space: unsquash Y so a circle there projects to a wide ellipse here.
  // This is what makes the disc read as an inclined plane, not a face-on vortex.
  vec2 d = vec2(c.x, c.y / COST);
  float dr   = length(d);
  float dang = atan(d.y, d.x);

  // Differential rotation: inner material orbits faster (Keplerian-ish).
  float spin = dang + 0.62/(max(dr,0.14)) - t*0.34;
  // Two noise scales: broad turbulence + fine radial filaments (streaks).
  float turb   = fbm(vec2(spin*2.1, dr*4.2 - t*0.05));
  float streaks= fbm(vec2(spin*7.5, dr*1.7 + t*0.02));
  float fine   = fbm(vec2(spin*3.3, dr*13.0 + t*0.03));

  // Radial profile: sharp inner edge, filamented body, SOFT outer falloff.
  // (A hard outer cutoff reads as a slab, not a disc.)
  float band = smoothstep(RIN, RIN+0.05, dr) * exp(-pow(max(dr - RIN, 0.0)/0.50, 1.7));
  float rr = clamp((dr - RIN) / (ROUT - RIN), 0.0, 1.4);

  // Doppler beaming: the approaching (left) side is far brighter and bluer.
  float side = cos(dang);
  float dop = 0.18 + 1.60*smoothstep(0.50, -1.0, side);
  float heat = band * (0.32 + 0.90*turb) * (0.50 + 0.80*streaks) * (0.80 + 0.30*fine) * dop;

  vec3 discCol = discColor(rr, heat);
  discCol = mix(discCol, discCol*vec3(0.72,0.86,1.25), smoothstep(0.30, -0.90, side)*0.55);

  // Lensed far side: a smooth Gaussian ellipse hugging the top of the horizon
  // (the iconic arc over the hole). Gaussian = no slab edges.
  float arcR = length(vec2(c.x, (c.y - BH*0.34)*1.30));
  float arc = exp(-pow((arcR - BH*1.02)/0.135, 2.0));
  float arcNoise = fbm(vec2(c.x*9.0 - t*0.08, c.y*13.0));
  vec3 arcCol = discColor(0.30, arc * (0.55 + 0.70*arcNoise) * (0.35 + 1.30*smoothstep(0.40, -1.0, side)) * 1.15);

  // ---- composite ----
  col += discCol;                                  // wings + hidden far side
  col += arcCol;                                   // lensed arc over the top
  float inside = 1.0 - smoothstep(BH-0.004, BH+0.004, r);
  col *= (1.0 - inside);                           // event horizon: pure black
  // Near side crossing IN FRONT of the horizon: soft horizontal band, fades at
  // both ends so there is no seam where it meets the sphere edge.
  float frontBand = exp(-pow((c.y + BH*0.45)/0.22, 2.0)) * smoothstep(0.0, 0.35, r);
  col += discCol * inside * frontBand;

  // Photon ring: thin, intense, just outside the horizon.
  float photon = exp(-260.0*abs(r - BH*1.035));
  vec3 photonCol = mix(vec3(1.0,0.88,0.62), vec3(0.72,0.92,1.0), 0.45 + 0.25*sin(ang + t*0.2));
  col += photonCol * photon * 1.35;

  // Faint outer glow so the hole sits in its own light.
  col += vec3(0.30,0.42,0.75) * exp(-3.6*abs(r - BH*1.45)) * 0.10;

  // Vignette + tone shaping (keeps UI readable at full intensity).
  col *= 1.0 - 0.42*dot(uv*0.52, uv*0.52);
  col = col / (1.0 + col*0.55);
  O = vec4(pow(max(col,0.0), vec3(0.92)) * uI, 1.0);
}`;

export default function ShaderBackground(props: { intensity: () => number; paused?: () => boolean }) {
  let canvas: HTMLCanvasElement | undefined;

  onMount(() => {
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "low-power" });
    if (!gl) return; // no WebGL2 - background stays plain, stated and silent
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uT = gl.getUniformLocation(prog, "uT");
    const uI = gl.getUniformLocation(prog, "uI");
    const uRes = gl.getUniformLocation(prog, "uRes");

    const resize = () => {
      if (!canvas) return;
      canvas.width = Math.floor(window.innerWidth / 2);  // half-res: cheap + soft
      canvas.height = Math.floor(window.innerHeight / 2);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uRes, canvas.width, canvas.height);
    };
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    let running = false;
    let frameNo = 0;
    const t0 = performance.now();
    const frame = () => {
      // 30fps is visually identical for this slow swirl and halves the only
      // continuous GPU-surface churn in the app (helps a driver/VPGPU that
      // evicts under heavy VRAM pressure).
      frameNo++;
      const draw = frameNo % 2 === 0;
      gl.uniform1f(uT, (performance.now() - t0) / 1000);
      gl.uniform1f(uI, props.intensity());
      if (draw) gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (running) raf = requestAnimationFrame(frame);
    };
    const start = () => { if (!running && props.intensity() > 0) { running = true; raf = requestAnimationFrame(frame); } };
    const stop = () => { running = false; cancelAnimationFrame(raf); };

    // Respect hidden tab: pause the cosmos when unseen.
    const vis = () => { document.hidden || props.intensity() === 0 ? stop() : start(); };
    document.addEventListener("visibilitychange", vis);
    createEffect(() => { props.intensity() === 0 ? stop() : start(); });

    start();
    onCleanup(() => { stop(); window.removeEventListener("resize", resize); document.removeEventListener("visibilitychange", vis); });
  });

  return (
    <canvas
      ref={canvas}
      style={{
        position: "fixed", inset: "0", width: "100%", height: "100%",
        "z-index": "0", "pointer-events": "none", opacity: "1",
      }}
    />
  );
}
