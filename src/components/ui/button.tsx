import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import Link from "next/link";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  [
    "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium",
    "transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    "disabled:pointer-events-none disabled:opacity-55 aria-disabled:pointer-events-none aria-disabled:opacity-55",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground shadow-xs hover:bg-primary-hover active:bg-primary-active",
        secondary: "bg-slate-100 text-slate-900 hover:bg-slate-200 active:bg-slate-300",
        outline:
          "border border-border-strong bg-white text-slate-800 shadow-xs hover:bg-slate-50 hover:text-slate-900 active:bg-slate-100",
        ghost: "text-slate-700 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200",
        destructive: "bg-red-700 text-white shadow-xs hover:bg-red-800 active:bg-red-900",
        link: "text-primary-600 underline-offset-4 hover:text-primary hover:underline",
      },
      size: {
        sm: "h-8 px-3 text-[13px]",
        md: "h-9 px-4 text-sm",
        lg: "h-10 px-5 text-sm",
        icon: "size-9",
      },
    },
    compoundVariants: [{ variant: "link", class: "h-auto px-0" }],
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;

export type ButtonProps = ComponentProps<"button"> &
  ButtonVariantProps & {
    /** Render the single child (e.g. a next/link <Link>) with button styles. */
    asChild?: boolean;
  };

/**
 * Button. Native `type` is preserved: inside a <form> a Button without `type`
 * submits it (HTML default) — pass `type="button"` for non-submit buttons.
 * Icon-only buttons (`size="icon"`) MUST have an `aria-label`.
 */
export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export type ButtonLinkProps = ComponentProps<typeof Link> & ButtonVariantProps;

/** A next/link styled as a button: `<ButtonLink href="/processos/novo">Novo processo</ButtonLink>`. */
export function ButtonLink({ className, variant, size, ...props }: ButtonLinkProps) {
  return <Link className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
