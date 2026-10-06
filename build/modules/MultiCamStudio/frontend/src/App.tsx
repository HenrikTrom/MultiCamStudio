import { useEffect, useState } from "react";
import { Aperture, Camera, CircleDot, Moon, Radio, Settings, Sun } from "lucide-react";
import CameraPage from "./components/CameraPage";
import CalibrationPage from "./components/CalibrationPage";
import RecordPage from "./components/RecordPage";
import SettingsModal from "./components/SettingsModal";
import { getRecorderStatus } from "./api/backend";

type Tab = "camera" | "calibration" | "record";

const tabs = [
  { id: "camera" as const, label: "Camera Check", icon: Radio },
  { id: "calibration" as const, label: "Calibration", icon: Aperture },
  { id: "record" as const, label: "Record", icon: CircleDot },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("camera");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [darkMode, setDarkMode] = useState(() => {
    try {
      return window.localStorage.getItem("multicamstudio-theme") !== "light";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
    try {
      window.localStorage.setItem("multicamstudio-theme", darkMode ? "dark" : "light");
    } catch { /* theme still works for this session */ }
  }, [darkMode]);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const status = await getRecorderStatus();
        if (active) setRecording(status.recording);
      } catch { /* keep the last known recorder state */ }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 500);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  return (
    <div className={darkMode ? "app-shell theme-dark" : "app-shell"}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Camera size={21} strokeWidth={1.8} /></div>
          <div><strong>MultiCam</strong><span>Control Studio</span><small>By Henrik Trommer</small></div>
        </div>

        <nav aria-label="Main navigation">
          <span className="nav-heading">Workspace</span>
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              className={`nav-item${activeTab === id ? " active" : ""}${id === "record" && recording ? " recording" : ""}`}
              key={id}
              onClick={() => setActiveTab(id)}
            >
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
              {id === "record" && <span className={recording ? "nav-dot recording" : "nav-dot"} />}
            </button>
          ))}
        </nav>

        <button className="settings-button" onClick={() => setSettingsOpen(true)}><Settings size={17} /> Settings</button>
        <button
          className="settings-button theme-toggle"
          type="button"
          onClick={() => setDarkMode((enabled) => !enabled)}
          aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"}
          aria-pressed={darkMode}
          title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
        >
          {darkMode ? <Sun size={17} /> : <Moon size={17} />}
          <span>{darkMode ? "Light mode" : "Dark mode"}</span>
        </button>
      </aside>

      <main className="main-content">
        {activeTab === "camera" && <CameraPage />}
        {activeTab === "calibration" && <CalibrationPage />}
        {activeTab === "record" && <RecordPage recording={recording} onRecordingChange={setRecording} />}
      </main>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
