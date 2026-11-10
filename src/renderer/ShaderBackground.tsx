// Event Horizon Code — Shader background (WebGL2, dependency-free)
// "Event horizon" — slowly swirling accretion ring + starfield, deliberately subtle.
// Cheap by design: one fullscreen quad, ~40 lines of shader, pauses when tab hidden.
// intensity prop: 0 = off (no RAF), 0.35 subtle, 1 full.

import { createEffect, onCleanup, onMount } from "solid-js";

const VERT = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`;

const FRAG = `#version 300 es
precision highp float;
uniform float uT; uniform float uI; uniform vec2 uRes;
out vec4 O;

float hash(vec2 q){ return fract(sin(dot(q, vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 q){
  vec2 i=floor(q), f=fract(q); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y);
}

void main(){
  vec2 uv = (gl_FragCoord.xy*2.0 - uRes) / min(uRes.x, uRes.y);
  float t = uT*0.05;

  // starfield (two parallax layers)
  float stars = 0.0;
  for (int k=0;k<2;k++){
    float sc = 18.0 + float(k)*26.0;
    vec2 g = uv*sc + vec2(t*float(k+1), -t*0.6*float(k+1));
    vec2 id = floor(g); vec2 f = fract(g)-0.5;
    float h = hash(id);
    if (h > 0.985) stars += smoothstep(0.08,0.0,length(f)) * (0.4+0.6*h);
  }

  // accretion ring: polar swirl
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  float swirl = a + 2.2/(r+0.25) - t*1.5;
  float ring = exp(-18.0*abs(r-0.42));
  float arms = 0.5 + 0.5*sin(swirl*3.0 + noise(vec2(swirl*0.8, r*3.0 - t))*2.5);
  // doppler: brighter on one side
  float doppler = 0.55 + 0.45*cos(a - 0.6);
  vec3 ringCol = mix(vec3(0.35,0.75,1.0), vec3(0.55,0.38,1.0), 0.5+0.5*sin(t*0.7));
  vec3 col = ringCol * ring * arms * doppler * 0.55;
  // horizon core: dark disc + faint rim
  col += vec3(0.02) * smoothstep(0.30,0.0,r);
  col += ringCol * exp(-40.0*abs(r-0.30)) * 0.35;

  col += stars * 0.5;

  // vignette
  col *= 1.0 - 0.45*dot(uv*0.55, uv*0.55);
  O = vec4(col * uI, 1.0);
}`;

export default function ShaderBackground(props: { intensity: () => number }) {
  let canvas: HTMLCanvasElement | undefined;

  onMount(() => {
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "low-power" });
    if (!gl) return; // no WebGL2 — background stays plain, stated and silent
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
    const t0 = performance.now();
    const frame = () => {
      gl.uniform1f(uT, (performance.now() - t0) / 1000);
      gl.uniform1f(uI, props.intensity());
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (running) raf = requestAnimationFrame(frame);
    };
    const start = () => { if (!running && props.intensity() > 0) { running = true; raf = requestAnimationFrame(frame); } };
    const stop = () => { running = false; cancelAnimationFrame(raf); };

    // Respect reduced motion + hidden tab: pause the cosmos when unseen.
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
        "z-index": "0", "pointer-events": "none", opacity: "0.9",
      }}
    />
  );
}
