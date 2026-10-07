"use client";

import type { ReactNode } from "react";
import { ChevronRight as ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div>
        {eyebrow && <p className="mb-1 text-[14px] font-semibold uppercase tracking-[0.18em] text-neutral-500">{eyebrow}</p>}
        <h2 className="text-xl font-semibold tracking-[-0.01em] text-neutral-950">{title}</h2>
        {description && <p className="mt-1 text-sm leading-6 text-neutral-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function ChevronRight({ className }: { className?: string }) {
  return (
    <ChevronRightIcon aria-hidden="true"
      className={cn("h-4 w-4 transition-transform duration-200 motion-safe:group-hover:translate-x-0.5", className)} />
  );
}
