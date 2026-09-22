import { useEffect, useState } from "react";
import { Save, X } from "lucide-react";
import {
  loadSettings,
  saveSettings,
  type JsonValue,
  type SettingsDocuments,
} from "../api/backend";

type DocumentName = keyof SettingsDocuments;

function JsonValueEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: JsonValue;
  onChange: (value: JsonValue) => void;
}) {
  if (Array.isArray(value)) {
    return (
      <fieldset className="json-group">
        <legend>{label}</legend>
        {value.map((item, index) => (
          <JsonValueEditor
            key={index}
            label={`Item ${index + 1}`}
            value={item}
            onChange={(next) => onChange(value.map((entry, position) => position === index ? next : entry))}
          />
        ))}
        {value.length === 0 && <small>Empty array</small>}
      </fieldset>
    );
  }

  if (value !== null && typeof value === "object") {
    return (
      <fieldset className="json-group">
        <legend>{label}</legend>
        {Object.entries(value).map(([key, item]) => (
          <JsonValueEditor
            key={key}
            label={key}
            value={item}
            onChange={(next) => onChange({ ...value, [key]: next })}
          />
        ))}
      </fieldset>
    );
  }

  if (typeof value === "boolean") {
    return (
      <label className="json-field">
        <span>{label}</span>
        <select value={String(value)} onChange={(event) => onChange(event.target.value === "true")}>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </label>
    );
  }

  if (typeof value === "number") {
    return (
      <label className="json-field">
        <span>{label}</span>
        <input
          type="number"
          value={value}
          onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
        />
      </label>
    );
  }

  return (
    <label className="json-field">
      <span>{label}</span>
      <input
        type="text"
        value={value ?? ""}
        placeholder={value === null ? "null" : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [documents, setDocuments] = useState<SettingsDocuments | null>(null);
  const [activeDocument, setActiveDocument] = useState<DocumentName>("calibration");
  const [loadingError, setLoadingError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    loadSettings().then(setDocuments).catch((error: unknown) => {
      setLoadingError(error instanceof Error ? error.message : "Could not load settings");
    });
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const updateDocument = (value: JsonValue) => {
    setSaved(false);
    setSaveError("");
    setDocuments((current) => current ? { ...current, [activeDocument]: value } : current);
  };

  const save = async () => {
    if (!documents) return;
    setSaving(true);
    setSaved(false);
    setSaveError("");
    try {
      await saveSettings(documents);
      setSaved(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header>
          <div><h2 id="settings-title">Configuration settings</h2><p>Edit values only. Field names and structure remain fixed.</p></div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close settings"><X size={18} /></button>
        </header>

        <div className="settings-tabs" role="tablist">
          <button className={activeDocument === "calibration" ? "active" : ""} onClick={() => setActiveDocument("calibration")}>Calibration</button>
          <button className={activeDocument === "camera" ? "active" : ""} onClick={() => setActiveDocument("camera")}>Camera</button>
        </div>

        <div className="settings-editor">
          {!documents && !loadingError && <p className="settings-message">Loading configuration…</p>}
          {loadingError && <p className="settings-error">{loadingError}</p>}
          {documents && (
            <JsonValueEditor
              label={activeDocument === "calibration" ? "Camera calibration settings" : "Camera settings"}
              value={documents[activeDocument]}
              onChange={updateDocument}
            />
          )}
        </div>

        <footer>
          <div aria-live="polite">
            {saveError && <p className="settings-error">{saveError}</p>}
            {saved && <p className="settings-success">Settings saved successfully.</p>}
          </div>
          <button className="primary-button" type="button" disabled={!documents || saving} onClick={save}>
            <Save size={15} />{saving ? "Validating…" : "Validate and save"}
          </button>
        </footer>
      </section>
    </div>
  );
}
