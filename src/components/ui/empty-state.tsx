import { Icon, type IconName } from "@/components/ui/icon";

interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description: string;
  action?: React.ReactNode;
}

export function EmptyState({
  icon = "search",
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
      <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-600">
        <Icon name={icon} className="size-5" />
      </span>
      <h2 className="mt-5 text-xl font-bold tracking-tight text-slate-950">
        {title}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">
        {description}
      </p>
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}
