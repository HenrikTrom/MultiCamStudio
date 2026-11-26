import { useEffect, useState } from "react";
import { X } from "lucide-react";

type Configuration = {
  calibration: { serial_numbers: string[] };
  ros: { domain: string; topicTemplate: string; previewLimit: number; configFile: string };
};

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<Configuration | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    void fetch("/local-api/config", { signal: controller.signal }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not load configuration");
      setConfig(payload);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load configuration");
    });
    return () => { controller.abort(); window.removeEventListener("keydown", escape); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header><div><h2 id="settings-title">Camera connections</h2><p>Current camera and ROS configuration.</p></div>
        <button className="modal-close" onClick={onClose} aria-label="Close settings"><X size={18} /></button></header>
      <div className="settings-editor">
        {error && <p className="settings-error">{error}</p>}
        {!config && !error && <p>Loading configuration…</p>}
        {config && <>
          <dl className="connection-settings">
            <dt>ROS domain</dt><dd>{config.ros.domain}</dd>
            <dt>Image topic template</dt><dd><code>{config.ros.topicTemplate}</code></dd>
            <dt>Preview limit</dt><dd>{config.ros.previewLimit} Hz per camera</dd>
            <dt>Camera IDs</dt><dd>{config.calibration.serial_numbers.join(", ")}</dd>
          </dl>
          <p>To change camera IDs, edit <code>cfg/CameraCalibrationSettings.json</code>. Change ROS connection settings in <code>.env</code>, then restart the container.</p>
        </>}
      </div>
      <footer><button className="primary-button" onClick={onClose}>Done</button></footer>
    </section>
  </div>;
}
