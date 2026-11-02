import { useEffect, useState } from "react";
import { Eye } from "lucide-react";
import { getEyeTrackerStatus, type EyeTrackerStatus } from "../api/backend";

export default function EyeTrackerStatusPanel() {
  const [status, setStatus] = useState<EyeTrackerStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let timer: number;
    const poll = async () => {
      let interval = 2000;
      try {
        const next = await getEyeTrackerStatus();
        if (!active) return;
        setStatus(next);
        setError("");
        interval = next.refreshIntervalMs;
      } catch (failure) {
        if (!active) return;
        setError(failure instanceof Error ? failure.message : "Eye tracker service unavailable");
      }
      if (active) timer = window.setTimeout(() => void poll(), interval);
    };
    void poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, []);

  return (
    <section className="surface settings-card eye-tracker-panel" aria-label="Eye tracker status">
      <div className="section-title"><div className="title-icon"><Eye size={19} /></div><div><h2>Eye trackers</h2><p>Connection checks refresh automatically.</p></div></div>
      <div role="status" aria-live="polite">
        {error && <p className="settings-error">Status unavailable: {error}</p>}
        {!status && !error && <p>Checking eye trackers…</p>}
        {status?.trackers.length === 0 && <p>No eye trackers configured. This session records FLIR cameras only.</p>}
        {status?.trackers.map((tracker) => <div className="source-row" key={tracker.endpoint}>
          <div><strong>{tracker.name}</strong><small>{tracker.endpoint}</small><small>{tracker.message}</small></div>
          <span className={`source-ready${error || !tracker.connected ? " offline" : ""}`}>{error ? "Unknown" : tracker.connected ? "Connected" : "Offline"}</span>
        </div>)}
      </div>
      <p className="recorder-note">Configure addresses and tracker count in <code>eye_tracker_settings.json</code>. Add or remove entries in <code>eye_trackers</code>.</p>
      {status && <p className="recorder-note">Last checked: {new Date(status.checkedAt).toLocaleTimeString()}{error ? " · Last check failed" : ""}. Connection status reports Pupil Remote availability.</p>}
    </section>
  );
}
