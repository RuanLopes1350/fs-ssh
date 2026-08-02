import * as React from "react";

import { cn } from "../../lib/cn";

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-[30px] w-full rounded-md border border-line-strong bg-background px-2.5 text-[13px] text-foreground placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "w-full rounded-md border border-line-strong bg-background px-2.5 py-1.5 text-[13px] text-foreground placeholder:text-faint focus:border-accent focus:outline-none",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
