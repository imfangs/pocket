import * as DropdownMenu from "@radix-ui/themes/components/dropdown-menu";
import { ArrowDownWideNarrow, CalendarDays, Clock3 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "./ui/IconButton";
import { t, useLocale } from "./i18n";
import type { ThreadSort } from "./types";
import "./thread-sort-menu.css";

const choices = [
  { value: "smart", label: "智能排序", Icon: ArrowDownWideNarrow },
  { value: "created", label: "创建时间", Icon: CalendarDays },
  { value: "activity", label: "活动时间", Icon: Clock3 },
] as const;

export default function ThreadSortMenu({ value, onChange, disabled = false }: {
  value: ThreadSort; onChange: (value: ThreadSort) => void; disabled?: boolean;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = choices.find(choice => choice.value === value) ?? choices[0];
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <DropdownMenu.Root modal={false} open={open} onOpenChange={next => setOpen(!disabled && next)}>
    <DropdownMenu.Trigger>
      <IconButton ref={trigger} type="button" className="thread-sort-trigger icon-button" disabled={disabled}
        data-sort-mode={value} aria-label={t("排序：{{label}}", { label: t(selected.label) })}
        title={t("排序：{{label}}", { label: t(selected.label) })}>
        <selected.Icon size={18} aria-hidden="true" />
      </IconButton>
    </DropdownMenu.Trigger>
    <DropdownMenu.Content className="thread-sort-menu" align="end" size="2" variant="soft" sideOffset={6}
      collisionPadding={12} aria-label={t("会话排序")} onCloseAutoFocus={event => {
        // A concurrently opened conversation or dialog owns its own entry focus.
        if (trigger.current?.closest("[inert]") || document.activeElement?.closest("dialog[open]")) event.preventDefault();
      }}>
      <DropdownMenu.RadioGroup value={value} onValueChange={next => {
        if (next !== value && choices.some(choice => choice.value === next)) onChange(next as ThreadSort);
      }}>
        {choices.map(({ value, label }) => <DropdownMenu.RadioItem key={value} value={value} data-sort-choice={value}>
          <span className="thread-sort-label">{t(label)}</span>
        </DropdownMenu.RadioItem>)}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content>
  </DropdownMenu.Root>;
}
