import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { latestCalibrationJsonUrl } from "../api/backend";

type Point3 = [number, number, number];
type CalibrationCamera = {
  SerialNumber: string;
  Intrinsic: number[];
  Extrinsic: number[];
};
type CalibrationData = {
  main_cam_serial?: string;
  CAMERAS: CalibrationCamera[];
};
type CameraGeometry = {
  serial: string;
  main: boolean;
  center: Point3;
  corners: Point3[];
  color: string;
};

const colors = ["#4fa574", "#5f8ed6", "#d28a4a", "#a56ccc", "#d45f65", "#56a5ad"];

function add(left: Point3, right: Point3): Point3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function cameraGeometry(data: CalibrationData): CameraGeometry[] {
  const centers = data.CAMERAS.map((camera) => {
    const matrix = camera.Extrinsic;
    const translation: Point3 = [matrix[3], matrix[7], matrix[11]];
    const center: Point3 = [
      -(matrix[0] * translation[0] + matrix[4] * translation[1] + matrix[8] * translation[2]),
      -(matrix[1] * translation[0] + matrix[5] * translation[1] + matrix[9] * translation[2]),
      -(matrix[2] * translation[0] + matrix[6] * translation[1] + matrix[10] * translation[2]),
    ];
    return { camera, center };
  });
  const baseline = Math.max(500, ...centers.flatMap((left) => centers.map((right) =>
    Math.hypot(left.center[0] - right.center[0], left.center[1] - right.center[1], left.center[2] - right.center[2]),
  )));
  const depth = baseline * 0.28;

  return centers.map(({ camera, center }, index) => {
    const intrinsic = camera.Intrinsic;
    const matrix = camera.Extrinsic;
    const fx = intrinsic[0];
    const fy = intrinsic[4];
    const cx = intrinsic[2];
    const cy = intrinsic[5];
    const imageCorners: Array<[number, number]> = [[0, 0], [1024, 0], [1024, 768], [0, 768]];
    const corners = imageCorners.map(([u, v]): Point3 => {
      const local: Point3 = [(u - cx) / fx * depth, (v - cy) / fy * depth, depth];
      return add(center, [
        matrix[0] * local[0] + matrix[4] * local[1] + matrix[8] * local[2],
        matrix[1] * local[0] + matrix[5] * local[1] + matrix[9] * local[2],
        matrix[2] * local[0] + matrix[6] * local[1] + matrix[10] * local[2],
      ]);
    });
    return {
      serial: camera.SerialNumber,
      main: camera.SerialNumber === data.main_cam_serial,
      center,
      corners,
      color: colors[index % colors.length],
    };
  });
}

function Scene({ data, referenceSerial }: { data: CalibrationData; referenceSerial: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ width: 800, height: 540 });
  const [view, setView] = useState({ yaw: 0, pitch: 0, zoom: 1 });
  const cameras = useMemo(() => cameraGeometry(data), [data]);

  useEffect(() => {
    setView({ yaw: 0, pitch: 0, zoom: 1 });
  }, [referenceSerial]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => setSize({
      width: Math.max(1, canvas.clientWidth),
      height: Math.max(1, canvas.clientHeight),
    }));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || cameras.length === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = size.width * ratio;
    canvas.height = size.height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size.width, size.height);

    const reference = data.CAMERAS.find((camera) => camera.SerialNumber === referenceSerial) ?? data.CAMERAS[0];
    const referenceMatrix = reference.Extrinsic;
    const toReference = (point: Point3): Point3 => [
      referenceMatrix[0] * point[0] + referenceMatrix[1] * point[1] + referenceMatrix[2] * point[2] + referenceMatrix[3],
      referenceMatrix[4] * point[0] + referenceMatrix[5] * point[1] + referenceMatrix[6] * point[2] + referenceMatrix[7],
      referenceMatrix[8] * point[0] + referenceMatrix[9] * point[1] + referenceMatrix[10] * point[2] + referenceMatrix[11],
    ];
    const allPoints = cameras.flatMap((camera) => [camera.center, ...camera.corners]);
    const radius = Math.max(1, ...allPoints.map((point) => Math.hypot(...toReference(point))));

    const project = (point: Point3) => {
      const referenced = toReference(point);
      const x = referenced[0] / radius;
      const y = referenced[1] / radius;
      const z = referenced[2] / radius;
      const cosYaw = Math.cos(view.yaw);
      const sinYaw = Math.sin(view.yaw);
      const yawX = cosYaw * x - sinYaw * z;
      const yawZ = sinYaw * x + cosYaw * z;
      const cosPitch = Math.cos(view.pitch);
      const sinPitch = Math.sin(view.pitch);
      const pitchY = cosPitch * y - sinPitch * yawZ;
      const pitchZ = sinPitch * y + cosPitch * yawZ;
      const perspective = 3.4 / Math.max(1.8, 3.4 - pitchZ);
      const scale = Math.min(size.width, size.height) * 0.42 * view.zoom * perspective;
      return { x: size.width / 2 + yawX * scale, y: size.height / 2 - pitchY * scale, z: pitchZ };
    };

    context.lineCap = "round";
    const drawLine = (from: Point3, to: Point3, color: string, width = 1) => {
      const a = project(from);
      const b = project(to);
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.strokeStyle = color;
      context.lineWidth = width;
      context.stroke();
    };

    cameras.slice().sort((left, right) => project(left.center).z - project(right.center).z).forEach((camera) => {
      const selected = camera.serial === referenceSerial;
      camera.corners.forEach((corner) => drawLine(camera.center, corner, camera.color, selected ? 2.2 : 1.4));
      camera.corners.forEach((corner, index) => drawLine(corner, camera.corners[(index + 1) % 4], camera.color, selected ? 2.2 : 1.4));
      const point = project(camera.center);
      context.beginPath();
      context.arc(point.x, point.y, selected ? 6 : 5, 0, Math.PI * 2);
      context.fillStyle = camera.color;
      context.fill();
      context.font = "600 11px Inter, sans-serif";
      context.fillStyle = "#26332b";
      const status = `${camera.main ? " · main" : ""}${selected ? " · reference" : ""}`;
      context.fillText(`${camera.serial}${status}`, point.x + 9, point.y - 8);
    });
  }, [cameras, data.CAMERAS, referenceSerial, size, view]);

  return (
    <canvas
      ref={canvasRef}
      className="calibration-3d-canvas"
      onPointerDown={(event) => {
        dragRef.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!dragRef.current) return;
        const dx = event.clientX - dragRef.current.x;
        const dy = event.clientY - dragRef.current.y;
        dragRef.current = { x: event.clientX, y: event.clientY };
        setView((current) => ({ ...current, yaw: current.yaw + dx * 0.008, pitch: Math.max(-1.4, Math.min(1.4, current.pitch + dy * 0.008)) }));
      }}
      onPointerUp={() => { dragRef.current = null; }}
      onPointerCancel={() => { dragRef.current = null; }}
      onWheel={(event) => {
        event.preventDefault();
        setView((current) => ({ ...current, zoom: Math.max(0.45, Math.min(3, current.zoom * Math.exp(-event.deltaY * 0.001))) }));
      }}
    />
  );
}

export default function Calibration3DDialog({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<CalibrationData | null>(null);
  const [referenceSerial, setReferenceSerial] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    fetch(latestCalibrationJsonUrl)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load calibration (HTTP ${response.status})`);
        return response.json() as Promise<CalibrationData>;
      })
      .then((calibration) => {
        if (!Array.isArray(calibration.CAMERAS) || calibration.CAMERAS.length === 0) {
          throw new Error("The latest calibration contains no cameras");
        }
        setData(calibration);
        setReferenceSerial(calibration.main_cam_serial ?? calibration.CAMERAS[0].SerialNumber);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load calibration"));
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="calibration-3d-dialog" role="dialog" aria-modal="true" aria-labelledby="calibration-3d-title">
        <header>
          <div><h2 id="calibration-3d-title">Camera field of view</h2><p>Choose a reference camera · Drag to rotate · Scroll to zoom</p></div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close 3D view"><X size={18} /></button>
        </header>
        {data && (
          <div className="camera-reference-tabs" aria-label="Camera reference frame">
            {data.CAMERAS.map((camera) => (
              <button
                type="button"
                className={referenceSerial === camera.SerialNumber ? "active" : ""}
                key={camera.SerialNumber}
                onClick={() => setReferenceSerial(camera.SerialNumber)}
              >
                {camera.SerialNumber}{camera.SerialNumber === data.main_cam_serial ? " · main" : ""}
              </button>
            ))}
          </div>
        )}
        <div className="calibration-3d-stage">
          {!data && !error && <span>Loading latest calibration…</span>}
          {error && <span className="settings-error">{error}</span>}
          {data && <Scene data={data} referenceSerial={referenceSerial} />}
        </div>
      </section>
    </div>
  );
}
