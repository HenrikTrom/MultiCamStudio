import { useEffect, useRef, useState } from "react";
import type { Camera } from "../api/backend";

export type FocusPeakingSettings = {
  enabled: boolean;
  threshold: number;
  softness: number;
  opacity: number;
  radius: number;
  maxFps: number;
  color: string;
};

export type HistogramData = {
  red: number[];
  green: number[];
  blue: number[];
  luminance: number[];
};

class ByteQueue {
  private parts: Uint8Array[] = [];
  private offset = 0;
  length = 0;

  push(value: Uint8Array) {
    this.parts.push(value);
    this.length += value.byteLength;
  }

  read(size: number) {
    const output = new Uint8Array(size);
    let position = 0;
    while (position < size) {
      const part = this.parts[0];
      const count = Math.min(size - position, part.byteLength - this.offset);
      output.set(part.subarray(this.offset, this.offset + count), position);
      position += count;
      this.offset += count;
      this.length -= count;
      if (this.offset === part.byteLength) {
        this.parts.shift();
        this.offset = 0;
      }
    }
    return output;
  }
}

function waitForMediaSource(mediaSource: MediaSource, signal: AbortSignal) {
  if (mediaSource.readyState === "open") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const opened = () => { cleanup(); resolve(); };
    const aborted = () => { cleanup(); reject(new DOMException("Aborted", "AbortError")); };
    const cleanup = () => {
      mediaSource.removeEventListener("sourceopen", opened);
      signal.removeEventListener("abort", aborted);
    };
    mediaSource.addEventListener("sourceopen", opened);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export default function CameraStream({
  camera,
  enabled,
  focus,
  onStatus,
  onHistogram,
}: {
  camera: Camera;
  enabled: boolean;
  focus: FocusPeakingSettings;
  onStatus: (message: string, error?: boolean) => void;
  onHistogram: (histogram: HistogramData) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const focusRef = useRef(focus);
  const [focusReady, setFocusReady] = useState(false);

  useEffect(() => { focusRef.current = focus; }, [focus]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!enabled) return;
    const mime = `video/mp4; codecs="${camera.codec}"`;
    if (!window.MediaSource || !MediaSource.isTypeSupported(mime)) {
      onStatus("This browser cannot play H.264 previews. Try Chrome or Edge.", true);
      return;
    }
    const controller = new AbortController();
    const play = async () => {
      const connection = new AbortController();
      const cancel = () => connection.abort();
      controller.signal.addEventListener("abort", cancel, { once: true });
      let objectUrl = "";
      try {
        const mediaSource = new MediaSource();
        objectUrl = URL.createObjectURL(mediaSource);
        video.src = objectUrl;
        await waitForMediaSource(mediaSource, connection.signal);
        const sourceBuffer = mediaSource.addSourceBuffer(mime);
        sourceBuffer.mode = "segments";
        sourceBuffer.addEventListener("error", () => connection.abort(), { once: true });
        const appendQueue: Array<{ data: Uint8Array; init: boolean; key: boolean }> = [];
        let initAppended = false;

        const pump = () => {
          if (sourceBuffer.updating || appendQueue.length === 0 || mediaSource.readyState !== "open") return;
          const item = appendQueue.shift();
          if (!item) return;
          try {
            sourceBuffer.appendBuffer(new Uint8Array(item.data).buffer);
            if (item.init) initAppended = true;
          } catch (error) {
            onStatus(error instanceof Error ? error.message : "Could not append video data", true);
          }
        };
        sourceBuffer.addEventListener("updateend", () => {
          if (video.buffered.length > 0) {
            const end = video.buffered.end(video.buffered.length - 1);
            if (video.paused) void video.play().catch(() => undefined);
            if (end - video.currentTime > 0.35) video.currentTime = Math.max(0, end - 0.08);
            if (video.buffered.start(0) < end - 3 && !sourceBuffer.updating) {
              try { sourceBuffer.remove(0, end - 2); } catch { /* retry on a later frame */ }
            }
          }
          onStatus("Live");
          pump();
        });

        const enqueue = (data: Uint8Array, flags: number) => {
          const item = { data, init: (flags & 1) !== 0, key: (flags & 2) !== 0 };
          appendQueue.push(item);
          if (appendQueue.length > 20) {
            let lastKey = -1;
            appendQueue.forEach((queued, index) => { if (queued.key) lastKey = index; });
            if (lastKey > 0) {
              const pendingInit = !initAppended ? appendQueue.find((queued) => queued.init) : undefined;
              appendQueue.splice(0, lastKey);
              if (pendingInit && !appendQueue[0]?.init) appendQueue.unshift(pendingInit);
            }
          }
          pump();
        };

        const response = await fetch(camera.source, { cache: "no-store", signal: connection.signal });
        if (!response.ok || !response.body) throw new Error(`Stream returned HTTP ${response.status}`);
        const reader = response.body.getReader();
        const readFrame = async () => {
          const timeout = window.setTimeout(() => connection.abort(), 5000);
          try { return await reader.read(); }
          finally { window.clearTimeout(timeout); }
        };
        const bytes = new ByteQueue();
        let header: { flags: number; size: number } | null = null;
        while (!controller.signal.aborted) {
          const { value, done } = await readFrame();
          if (done) break;
          bytes.push(value);
          while (true) {
            if (!header) {
              if (bytes.length < 13) break;
              const raw = bytes.read(13);
              const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
              header = { flags: raw[0], size: view.getUint32(1, false) };
            }
            if (bytes.length < header.size) break;
            enqueue(bytes.read(header.size), header.flags);
            header = null;
          }
        }
        if (!controller.signal.aborted) throw new Error("Stream ended");
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        connection.abort();
        if (video.getAttribute("src") === objectUrl) {
          video.removeAttribute("src");
          video.load();
        }
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    };

    void (async () => {
      while (!controller.signal.aborted) {
        onStatus("Connecting…");
        try { await play(); }
        catch (error) {
          if (!controller.signal.aborted) onStatus(
            `${error instanceof DOMException && error.name === "AbortError" ? "Preview interrupted" : error instanceof Error ? error.message : "Stream failed"} · reconnecting…`, true);
        }
        if (controller.signal.aborted) break;
        await new Promise<void>((done) => {
          const finish = () => { window.clearTimeout(timer); controller.signal.removeEventListener("abort", finish); done(); };
          const timer = window.setTimeout(finish, 1500);
          controller.signal.addEventListener("abort", finish, { once: true });
        });
      }
    })();
    return () => controller.abort();
  }, [enabled, camera.codec, camera.source, onStatus]);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !enabled) return;
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false });
    if (!gl) {
      return;
    }
    const shaders: WebGLShader[] = [];
    let program: WebGLProgram | null = null;
    let buffer: WebGLBuffer | null = null;
    let texture: WebGLTexture | null = null;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Could not create focus shader");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "Focus shader failed");
      return shader;
    };

    let animation = 0;
    try {
      program = gl.createProgram();
      if (!program) throw new Error("Could not create focus program");
      gl.attachShader(program, compile(gl.VERTEX_SHADER, `#version 300 es
        in vec2 aPosition; out vec2 vUv;
        void main(){vUv=aPosition*.5+.5;gl_Position=vec4(aPosition,0.,1.);}`));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `#version 300 es
        precision highp float;
        uniform sampler2D uFrame; uniform vec2 uTexel; uniform float uThreshold;
        uniform float uSoftness; uniform float uOpacity; uniform float uRadius; uniform vec3 uPeakColor;
        in vec2 vUv; out vec4 outColor;
        float luma(vec3 color){return dot(color,vec3(.2126,.7152,.0722));}
        void main(){
          vec3 base=texture(uFrame,vUv).rgb; vec2 delta=uTexel*uRadius;
          float gx=luma(texture(uFrame,vUv+vec2(delta.x,0.)).rgb)-luma(texture(uFrame,vUv-vec2(delta.x,0.)).rgb);
          float gy=luma(texture(uFrame,vUv+vec2(0.,delta.y)).rgb)-luma(texture(uFrame,vUv-vec2(0.,delta.y)).rgb);
          float peak=smoothstep(uThreshold,uThreshold+uSoftness,length(vec2(gx,gy)));
          outColor=vec4(mix(base,uPeakColor,peak*uOpacity),1.);
        }`));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "Focus program failed");
      gl.useProgram(program);
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, "aPosition");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      const uniforms = {
        texel: gl.getUniformLocation(program, "uTexel"), threshold: gl.getUniformLocation(program, "uThreshold"),
        softness: gl.getUniformLocation(program, "uSoftness"), opacity: gl.getUniformLocation(program, "uOpacity"),
        radius: gl.getUniformLocation(program, "uRadius"), color: gl.getUniformLocation(program, "uPeakColor"),
      };
      let lastDraw = 0;
      const draw = (now: number) => {
        animation = requestAnimationFrame(draw);
        const settings = focusRef.current;
        if (!settings.enabled || video.readyState < 2 || now - lastDraw < 1000 / settings.maxFps) return;
        lastDraw = now;
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height) return;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
          gl.viewport(0, 0, width, height);
        }
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video); } catch { return; }
        const color = Number.parseInt(settings.color.slice(1), 16);
        gl.uniform2f(uniforms.texel, 1 / width, 1 / height);
        gl.uniform1f(uniforms.threshold, settings.threshold);
        gl.uniform1f(uniforms.softness, settings.softness);
        gl.uniform1f(uniforms.opacity, settings.opacity);
        gl.uniform1f(uniforms.radius, settings.radius);
        gl.uniform3f(uniforms.color, ((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      };
      setFocusReady(true);
      animation = requestAnimationFrame(draw);
    } catch (error) {
      setFocusReady(false);
      console.warn("Focus peaking unavailable", error);
    }
    return () => {
      cancelAnimationFrame(animation);
      setFocusReady(false);
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      shaders.forEach((shader) => gl.deleteShader(shader));
    };
  }, [enabled]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !enabled) return;
    const sample = document.createElement("canvas");
    sample.width = 160;
    sample.height = 120;
    const context = sample.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    const timer = window.setInterval(() => {
      if (video.readyState < 2) return;
      try {
        context.drawImage(video, 0, 0, sample.width, sample.height);
        const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
        const red = Array<number>(256).fill(0);
        const green = Array<number>(256).fill(0);
        const blue = Array<number>(256).fill(0);
        const luminance = Array<number>(256).fill(0);
        for (let index = 0; index < pixels.length; index += 4) {
          const r = pixels[index];
          const g = pixels[index + 1];
          const b = pixels[index + 2];
          red[r]++;
          green[g]++;
          blue[b]++;
          luminance[Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b))]++;
        }
        const maximum = Math.max(1, ...red, ...green, ...blue, ...luminance);
        onHistogram({
          red: red.map((value) => value / maximum),
          green: green.map((value) => value / maximum),
          blue: blue.map((value) => value / maximum),
          luminance: luminance.map((value) => value / maximum),
        });
      } catch { /* the next 10 Hz sample can retry */ }
    }, 100);
    return () => window.clearInterval(timer);
  }, [enabled, onHistogram]);

  return (
    <>
      <video ref={videoRef} muted autoPlay playsInline className={enabled && focus.enabled && focusReady ? "focus-source" : ""} />
      <canvas ref={canvasRef} className={enabled && focus.enabled && focusReady ? "focus-canvas active" : "focus-canvas"} />
    </>
  );
}
