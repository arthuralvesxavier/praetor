import { CircleAlert, CircleCheck, Info, Sparkles, TriangleAlert } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { TONE_CLASSES } from "@/lib/tones";
import { cn } from "@/lib/utils";

export type CalloutTone = "info" | "warning" | "danger" | "success" | "ai";

const icons: Record<CalloutTone, ReactNode> = {
  info: <Info />,
  warning: <TriangleAlert />,
  danger: <CircleAlert />,
  success: <CircleCheck />,
  ai: <Sparkles />,
};

export type CalloutProps = Omit<ComponentProps<"div">, "title"> & {
  tone?: CalloutTone;
  title?: ReactNode;
  /** Override the default icon (pass `null` to hide it). */
  icon?: ReactNode | null;
  children?: ReactNode;
};

/**
 * Inline message box. `tone="ai"` (violet) is reserved for AI disclaimers and
 * AI-generated content. Pass `role="alert"` only for messages that appear dynamically.
 */
export function Callout({ tone = "info", title, icon, className, children, ...props }: CalloutProps) {
  const t = TONE_CLASSES[tone];
  const iconNode = icon === undefined ? icons[tone] : icon;
  return (
    <div className={cn("flex gap-3 rounded-md border px-4 py-3 text-sm", t.soft, className)} {...props}>
      {iconNode ? (
        <span aria-hidden="true" className="mt-0.5 inline-flex shrink-0 opacity-90 [&_svg]:size-4">
          {iconNode}
        </span>
      ) : null}
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="leading-relaxed [&_a]:font-medium [&_a]:underline">{children}</div> : null}
      </div>
    </div>
  );
}
