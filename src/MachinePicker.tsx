import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import { useState } from "react";
import { Laptop } from "lucide-react";
import { changeMachine, currentMachineId, machines, type MachineId } from "./machineScope";
import "./machine-picker.css";

export default function MachinePicker() {
  useLocale();
  const [error, setError] = useState("");
  if (machines.length === 1 && currentMachineId() === machines[0].id)
    return <div className="machine-picker"><span><AppIcon icon={Laptop} kind="auxiliary" aria-hidden="true" /> {machines[0].label}</span></div>;
  return <div className="machine-picker">
    <label><AppIcon icon={Laptop} kind="auxiliary" aria-hidden="true" /><span className="sr-only">{t("选择电脑")}</span>
      <select aria-label={t("选择电脑")} value={currentMachineId() ?? ""} onChange={event => {
        try { setError(changeMachine(event.target.value as MachineId) ?? ""); }
        catch (failure) { setError(failure instanceof Error ? failure.message : "暂时无法切换电脑，请重试。"); }
      }}>
        <option value="" disabled>{t("选择电脑")}</option>
        {machines.map(machine => <option key={machine.id} value={machine.id}>{machine.label}</option>)}
      </select>
    </label>
    {error && <p role="alert">{t(error)}</p>}
  </div>;
}
