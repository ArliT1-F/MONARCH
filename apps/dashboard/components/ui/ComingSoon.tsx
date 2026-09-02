export function ComingSoon({
  title,
  phase,
  description,
}: {
  title: string;
  phase: string;
  description: string;
}) {
  return (
    <main className="flex min-h-[70vh] items-center justify-center px-8">
      <div className="max-w-md text-center">
        <p className="mb-3 inline-block rounded-full border border-royal-500/30 bg-royal-500/10 px-3 py-1 text-[11px] font-medium text-royal-400">
          Planned · {phase}
        </p>
        <h1 className="mb-3 text-2xl font-semibold tracking-tight text-ink-100">{title}</h1>
        <p className="text-sm leading-relaxed text-ink-300">{description}</p>
        <p className="mt-6 text-xs text-ink-400">
          Monarch ships features in phases — the Server Designer is the current milestone. The
          shared schema, validation, diff and target-resolver layers this feature needs already
          exist.
        </p>
      </div>
    </main>
  );
}
