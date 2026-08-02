import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "../../lib/cn";

export const TooltipProvider = TooltipPrimitive.Provider;

/** Tooltip de uma linha — usado na sidebar recolhida (só ícones). */
export function Tooltip({
  content,
  side = "right",
  children,
}: {
  content: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  children: React.ReactNode;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn(
            "z-[80] rounded-md border border-line-strong bg-surface px-2 py-1 text-[11px] text-foreground shadow-[0_8px_24px_#000a]",
            "data-[state=delayed-open]:animate-[--animate-in-fade]",
          )}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
