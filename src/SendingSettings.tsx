import { t, useLocale } from "./i18n";
import { Switch } from "@radix-ui/themes/components/switch";
import { useId, useSyncExternalStore } from "react";
import { currentMachineId } from "./machineScope";
import { readAutoDirectPreference, saveAutoDirectPreference, subscribeSendingPreference } from "./sendingPreference";
import "./sending-settings.css";

export default function SendingSettings() {
  useLocale();
  const autoDirect = useSyncExternalStore(subscribeSendingPreference, readAutoDirectPreference, readAutoDirectPreference);
  const id = useId();
  return <section className="sending-setting" aria-label={t("发送设置")}>
    <div className="sending-setting-row">
      <label htmlFor={id}>{t("自动直接发送")}</label>
      <span className="sending-setting-control">
        <Switch id={id} type="button" size="3" checked={autoDirect} disabled={!currentMachineId()}
          aria-describedby={`${id}-help`} onCheckedChange={saveAutoDirectPreference} />
      </span>
    </div>
    <p id={`${id}-help`} className="field-help">{t("支持时立即发送，否则排队。仅对新提交的消息生效。")}</p>
  </section>;
}
