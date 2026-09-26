import { cn } from "@/shared/lib/utils";

interface AdminPageHeaderProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
  className?: string;
  section?: string;
}

export function AdminPageHeader({ title, description, children, className, section = "Administration" }: AdminPageHeaderProps) {
  return (
    <header className={cn("admin-page-header", className)}>
      <div className="min-w-0">
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground">{section}</p>
        <h1 className="text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">{title}</h1>
        {description && (
          <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {children && <div className="admin-page-actions">{children}</div>}
    </header>
  );
}
