import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md text-[13px] font-medium whitespace-nowrap transition-colors cursor-pointer select-none disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
  {
    variants: {
      variant: {
        default:
          "bg-accent text-[#05080f] font-semibold hover:brightness-110 border border-accent",
        outline:
          "border border-line-strong text-foreground hover:bg-hover",
        ghost: "text-dim hover:bg-hover hover:text-foreground",
        danger: "border border-danger text-danger hover:bg-danger/10",
        quiet:
          "border border-line-strong bg-background text-dim hover:text-foreground hover:border-faint",
      },
      size: {
        default: "h-[30px] px-3.5",
        sm: "h-[26px] px-2.5 text-xs",
        icon: "h-7 w-7 p-0",
      },
    },
    defaultVariants: { variant: "outline", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
