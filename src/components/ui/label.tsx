import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";

import { cn } from "../../lib/cn";

export const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn("text-[11px] text-dim select-none", className)}
    {...props}
  />
));
Label.displayName = "Label";

/** Campo rotulado — o par label+controle aparece dezenas de vezes no app. */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      {label && <Label>{label}</Label>}
      {children}
      {hint && <span className="text-[11px] text-faint">{hint}</span>}
    </div>
  );
}
