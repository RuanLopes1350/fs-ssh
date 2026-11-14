import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "../../lib/cn";

export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;

/**
 * Painel deslizante (shadcn/ui sobre Radix Dialog).
 *
 * O overlay é bem leve de propósito: o formulário de conexão aplica cor e tema
 * ao vivo, e escurecer demais o fundo esconderia justamente o terminal que
 * está sendo pré-visualizado.
 */
export const SheetContent = React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> & {
    side?: "right" | "left";
    /** Impede o fechamento por clique fora/Esc (usado com confirmação própria). */
    blockOutside?: boolean;
  }
>(({ className, children, side = "right", blockOutside, ...props }, ref) => {
  // Se o Sheet desmontar com um Select interno ainda aberto, o DismissableLayer
  // do Radix pode deixar `pointer-events: none` preso no body.
  React.useEffect(
    () => () => {
      if (document.body.style.pointerEvents === "none") {
        document.body.style.pointerEvents = "";
      }
    },
    [],
  );

  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-[#05070b66] data-[state=open]:animate-[--animate-in-fade] data-[state=closed]:animate-[--animate-out-fade]" />
      <SheetPrimitive.Content
        ref={ref}
        onInteractOutside={(e) => blockOutside && e.preventDefault()}
        className={cn(
          "fixed inset-y-0 z-50 flex h-full w-[min(460px,90vw)] flex-col border-line-strong bg-surface shadow-[0_0_60px_#000a] focus:outline-none",
          side === "right"
            ? "right-0 border-l data-[state=open]:animate-[--animate-in-right] data-[state=closed]:animate-[--animate-out-right]"
            : "left-0 border-r data-[state=open]:animate-[--animate-in-fade] data-[state=closed]:animate-[--animate-out-fade]",
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-foreground focus:outline-none">
          <X size={14} />
          <span className="sr-only">Fechar</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
});
SheetContent.displayName = "SheetContent";

export function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-none flex-col gap-0.5 border-b border-line px-4 py-3 pr-10",
        className,
      )}
      {...props}
    />
  );
}

export function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-4", className)}
      {...props}
    />
  );
}

export function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-none items-center gap-2 border-t border-line px-4 py-3",
        className,
      )}
      {...props}
    />
  );
}

export const SheetTitle = React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn("flex items-center gap-2 text-[13px] font-semibold", className)}
    {...props}
  />
));
SheetTitle.displayName = "SheetTitle";

export const SheetDescription = React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn("text-[11px] text-faint", className)}
    {...props}
  />
));
SheetDescription.displayName = "SheetDescription";
