import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "../../lib/cn";

export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-[18px] w-[32px] flex-none cursor-pointer items-center rounded-full border border-line-strong transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=unchecked]:bg-background",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block h-3 w-3 rounded-full bg-faint shadow transition-transform data-[state=checked]:translate-x-[15px] data-[state=checked]:bg-[#05080f] data-[state=unchecked]:translate-x-[2px]" />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";

/** Linha "rótulo + descrição + switch" usada na tela de configurações. */
export function SwitchRow({
  label,
  hint,
  checked,
  onCheckedChange,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <Switch checked={checked} onCheckedChange={onCheckedChange} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-[13px]">{label}</span>
        {hint && <span className="block text-[11px] text-faint">{hint}</span>}
      </span>
    </label>
  );
}
