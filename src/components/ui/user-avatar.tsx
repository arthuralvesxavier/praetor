import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

export type UserAvatarProps = {
  name: string | null | undefined;
  size?: "sm" | "md" | "lg";
  /**
   * Decorative by default (the name is usually shown next to it). Set to true
   * when the avatar stands alone: it then gets role="img" + the name as label.
   */
  labelled?: boolean;
  className?: string;
};

const sizes = { sm: "size-6 text-[10px]", md: "size-8 text-xs", lg: "size-10 text-sm" } as const;

/** Initials avatar ("Camila Rocha" -> "CR"). */
export function UserAvatar({ name, size = "md", labelled = false, className }: UserAvatarProps) {
  return (
    <span
      aria-hidden={labelled ? undefined : true}
      role={labelled ? "img" : undefined}
      aria-label={labelled ? (name ?? "Usuário") : undefined}
      title={labelled ? (name ?? undefined) : undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-primary-100 font-semibold text-primary-800 select-none",
        sizes[size],
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
