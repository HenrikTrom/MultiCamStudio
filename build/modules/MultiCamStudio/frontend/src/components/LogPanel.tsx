import { useEffect, useRef } from "react";
import { ChevronDown, Terminal } from "lucide-react";
import type { LogEntry } from "../api/backend";
import AnsiText from "./AnsiText";

export default function LogPanel({ title, logs, onClear }: { title: string; logs: LogEntry[]; onClear: () => void }) {
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [logs]);

  return (
    <section className="log-panel">
      <header><div><Terminal size={16} /><strong>{title}</strong><span>{logs.length} events</span></div><div><button onClick={onClear}>Clear</button><button aria-label="Collapse log"><ChevronDown size={16} /></button></div></header>
      <div className="terminal-output" ref={outputRef}>
        {logs.length === 0 && <p className="empty-log">No output to display.</p>}
        {logs.map((log) => <p key={log.id}><time>{log.time}</time><span className={`log-level ${log.level}`}>{log.level === "success" ? "DONE" : log.level.toUpperCase()}</span><span className="log-message"><AnsiText text={log.message} /></span></p>)}
      </div>
    </section>
  );
}
