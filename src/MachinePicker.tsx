import { useState } from "react";
import { Laptop } from "lucide-react";
import { changeMachine, currentMachineId, machines, type MachineId } from "./machineScope";
import "./machine-picker.css";

export default function MachinePicker() {
  const [error, setError] = useState("");
  return <div className="machine-picker">
    <label><Laptop size={16} aria-hidden="true" /><span className="sr-only">选择电脑</span>
      <select aria-label="选择电脑" value={currentMachineId() ?? ""} onChange={event => {
        try { setError(changeMachine(event.target.value as MachineId) ?? ""); }
        catch (failure) { setError(failure instanceof Error ? failure.message : "暂时无法切换电脑，请重试。"); }
      }}>
        <option value="" disabled>选择电脑</option>
        {machines.map(machine => <option key={machine.id} value={machine.id}>{machine.label}</option>)}
      </select>
    </label>
    {error && <p role="alert">{error}</p>}
  </div>;
}
